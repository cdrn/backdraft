import { createPublicClient, http, parseUnits, type PublicClient } from "viem";
import type { ChainConfig, DexConfig, EvmToken, PairConfig } from "../config.js";
import type { DexQuote } from "../types.js";

// One quoter per chain, covering every DEX on it. Every
// dex × pair × direction × size × live-tier quote for a tick is packed into
// Multicall3 eth_calls (viem chunks by calldata size so each call stays
// well under the public-RPC gas cap). Multicall3 uses CALL, so the
// revert-and-catch trick every quoter flavour relies on works inside it.
//
// Tiers are discovered on demand: a buy per (dex, pair, tier) at the
// smallest and largest clip, once at startup and then hourly. Per (dex,
// pair) we keep the best tier at each end — the deep-near-spot pool and the
// deep-overall pool, usually the same one — so a tick quotes one or two
// tiers per pool instead of every tier that exists.

const UNIV3_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// Aerodrome Slipstream: identical shape, int24 tickSpacing in place of fee.
const SLIPSTREAM_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "tickSpacing", type: "int24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// Camelot V3 (Algebra): one pool per pair, dynamic fee returned.
const ALGEBRA_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "limitSqrtPrice", type: "uint160" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "fee", type: "uint16" },
    ],
  },
] as const;

// Uniswap V4: PoolKey-addressed, native ETH is currency 0x0.
const UNIV4_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000" as const;
// Canonical V4 tick spacing per fee tier (hookless pools).
const V4_TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

export interface QuoteRequest {
  pair: string;
  dir: "buy" | "sell";
  amountIn: number; // USDC for buy, base units for sell
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Contract = { address: `0x${string}`; abi: any; functionName: string; args: any };

function buildCall(
  dex: DexConfig,
  chain: ChainConfig,
  tokenIn: EvmToken,
  tokenOut: EvmToken,
  amountIn: bigint,
  tier: number,
  pair: string,
): Contract | null {
  switch (dex.kind) {
    case "univ3":
      return {
        address: dex.quoter,
        abi: UNIV3_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, fee: tier, sqrtPriceLimitX96: 0n }],
      };
    case "slipstream":
      return {
        address: dex.quoter,
        abi: SLIPSTREAM_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, tickSpacing: tier, sqrtPriceLimitX96: 0n }],
      };
    case "algebra":
      return {
        address: dex.quoter,
        abi: ALGEBRA_ABI,
        functionName: "quoteExactInputSingle",
        args: [tokenIn.address, tokenOut.address, amountIn, 0n],
      };
    case "univ4": {
      const tickSpacing = V4_TICK_SPACING[tier];
      if (tickSpacing === undefined) return null;
      // V4's deep ETH pools are native-ETH pools, not WETH.
      const cur = (t: EvmToken) => (pair === "ETH" && t.symbol === "WETH" ? ZERO : t.address);
      const a = cur(tokenIn);
      const b = cur(tokenOut);
      const zeroForOne = a.toLowerCase() < b.toLowerCase();
      const [currency0, currency1] = zeroForOne ? [a, b] : [b, a];
      return {
        address: dex.quoter,
        abi: UNIV4_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: { currency0, currency1, fee: tier, tickSpacing, hooks: ZERO }, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
      };
    }
  }
}

export class ChainQuoter {
  readonly chain: string;
  readonly dexes: DexConfig[];
  private client: PublicClient;
  // live tiers per `${dex.id}|${pair}`; absent = not yet discovered (try all)
  private live = new Map<string, number[]>();
  discoveredAt = 0;

  constructor(
    private config: ChainConfig,
    dexes: DexConfig[],
    private pairs: PairConfig[],
  ) {
    this.chain = config.name;
    this.dexes = dexes.filter((d) => d.chain === config.name);
    this.client = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl, { timeout: 15_000 }),
    });
  }

  supports(pair: string): boolean {
    return this.dexes.length > 0 && Boolean(this.pairs.find((p) => p.pair === pair)?.tokens[this.chain]);
  }

  private tiersFor(dex: DexConfig, pair: string): number[] {
    return this.live.get(`${dex.id}|${pair}`) ?? dex.tiers;
  }

  // Which pools to quote: buy `sizesUsd` of every (dex, pair, tier); per
  // (dex, pair) keep the tier that returned the most at each size. Called at
  // startup and periodically.
  async discover(sizesUsd: number[]): Promise<Map<string, number[]>> {
    const probes: { dex: DexConfig; pair: string; tier: number; size: number; contract: Contract }[] = [];
    for (const dex of this.dexes) {
      for (const p of this.pairs) {
        const tok = p.tokens[this.chain];
        if (!tok) continue;
        for (const size of sizesUsd) {
          const amountIn = parseUnits(size.toFixed(this.config.usdc.decimals), this.config.usdc.decimals);
          for (const tier of dex.tiers) {
            const c = buildCall(dex, this.config, this.config.usdc, tok, amountIn, tier, p.pair);
            if (c) probes.push({ dex, pair: p.pair, tier, size, contract: c });
          }
        }
      }
    }
    if (!probes.length) return this.live;
    const results = await this.client.multicall({
      contracts: probes.map((p) => p.contract),
      allowFailure: true,
      batchSize: this.config.multicallBatchBytes,
    });
    // best tier per (dex, pair, size)
    const best = new Map<string, { tier: number; out: bigint }>();
    results.forEach((r, i) => {
      if (r.status !== "success") return;
      const out = (r.result as readonly bigint[])[0];
      if (!(out > 0n)) return;
      const p = probes[i];
      const key = `${p.dex.id}|${p.pair}|${p.size}`;
      const prev = best.get(key);
      if (!prev || out > prev.out) best.set(key, { tier: p.tier, out });
    });
    const found = new Map<string, number[]>();
    for (const [key, b] of best) {
      const k = key.slice(0, key.lastIndexOf("|"));
      const tiers = found.get(k) ?? found.set(k, []).get(k)!;
      if (!tiers.includes(b.tier)) tiers.push(b.tier);
    }
    // a (dex, pair) with no live pool at all gets an empty list → never quoted
    for (const dex of this.dexes)
      for (const p of this.pairs)
        if (p.tokens[this.chain] && !found.has(`${dex.id}|${p.pair}`)) found.set(`${dex.id}|${p.pair}`, []);
    this.live = found;
    this.discoveredAt = Date.now();
    return found;
  }

  liveSummary(): string {
    return [...this.live.entries()]
      .filter(([, t]) => t.length)
      .map(([k, t]) => `${k}:${t.join("/")}`)
      .join(" ");
  }

  async quoteMany(reqs: QuoteRequest[]): Promise<DexQuote[]> {
    const calls: { req: QuoteRequest; dex: DexConfig; tier: number; outDecimals: number; contract: Contract }[] = [];
    for (const req of reqs) {
      const tok = this.pairs.find((p) => p.pair === req.pair)?.tokens[this.chain];
      if (!tok) continue;
      const [inTok, outTok] = req.dir === "buy" ? [this.config.usdc, tok] : [tok, this.config.usdc];
      const amountIn = parseUnits(req.amountIn.toFixed(inTok.decimals), inTok.decimals);
      if (amountIn <= 0n) continue;
      for (const dex of this.dexes) {
        for (const tier of this.tiersFor(dex, req.pair)) {
          const c = buildCall(dex, this.config, inTok, outTok, amountIn, tier, req.pair);
          if (c) calls.push({ req, dex, tier, outDecimals: outTok.decimals, contract: c });
        }
      }
    }
    if (calls.length === 0) return [];

    const results = await this.client.multicall({
      contracts: calls.map((c) => c.contract),
      allowFailure: true,
      batchSize: this.config.multicallBatchBytes,
    });

    const ts = Date.now();
    const best = new Map<string, DexQuote>();
    results.forEach((r, i) => {
      if (r.status !== "success") return;
      const c = calls[i];
      const amountOut = Number((r.result as readonly bigint[])[0]) / 10 ** c.outDecimals;
      if (!(amountOut > 0)) return;
      const key = `${c.dex.id}|${c.req.pair}|${c.req.dir}|${c.req.amountIn}`;
      const prev = best.get(key);
      if (!prev || amountOut > prev.amountOut) {
        best.set(key, {
          ts,
          chain: this.chain,
          dex: c.dex.id,
          pair: c.req.pair,
          dir: c.req.dir,
          amountIn: c.req.amountIn,
          amountOut,
          feeTier: c.tier,
        });
      }
    });
    return [...best.values()];
  }
}
