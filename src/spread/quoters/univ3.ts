import { createPublicClient, http, parseUnits, type PublicClient } from "viem";
import type { ChainConfig, PairConfig } from "../config.js";
import type { DexQuote } from "../types.js";

const QUOTER_V2_ABI = [
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

export interface QuoteRequest {
  pair: string;
  dir: "buy" | "sell";
  amountIn: number; // USDC for buy, base units for sell
}

// One Multicall3 eth_call per chain per tick covers every
// pair × direction × size × fee tier. Multicall3 uses CALL (not STATICCALL),
// so QuoterV2's revert-and-catch trick works inside it. Per request we keep
// the tier with the best output — that's the executable single-hop price.
export class UniV3Quoter {
  readonly chain: string;
  private client: PublicClient;

  constructor(
    private config: ChainConfig,
    private pairs: PairConfig[],
  ) {
    this.chain = config.name;
    this.client = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl, { timeout: 10_000 }),
    });
  }

  supports(pair: string): boolean {
    return Boolean(this.pairs.find((p) => p.pair === pair)?.tokens[this.chain]);
  }

  async quoteMany(reqs: QuoteRequest[]): Promise<DexQuote[]> {
    const calls: {
      req: QuoteRequest;
      fee: number;
      outDecimals: number;
      contract: {
        address: `0x${string}`;
        abi: typeof QUOTER_V2_ABI;
        functionName: "quoteExactInputSingle";
        args: readonly [
          {
            tokenIn: `0x${string}`;
            tokenOut: `0x${string}`;
            amountIn: bigint;
            fee: number;
            sqrtPriceLimitX96: bigint;
          },
        ];
      };
    }[] = [];

    for (const req of reqs) {
      const tok = this.pairs.find((p) => p.pair === req.pair)?.tokens[this.chain];
      if (!tok) continue;
      const [inTok, outTok] =
        req.dir === "buy" ? [this.config.usdc, tok] : [tok, this.config.usdc];
      const amountIn = parseUnits(req.amountIn.toFixed(inTok.decimals), inTok.decimals);
      for (const fee of this.config.feeTiers) {
        calls.push({
          req,
          fee,
          outDecimals: outTok.decimals,
          contract: {
            address: this.config.quoterV2,
            abi: QUOTER_V2_ABI,
            functionName: "quoteExactInputSingle",
            args: [
              {
                tokenIn: inTok.address,
                tokenOut: outTok.address,
                amountIn,
                fee,
                sqrtPriceLimitX96: 0n,
              },
            ],
          },
        });
      }
    }
    if (calls.length === 0) return [];

    const results = await this.client.multicall({
      contracts: calls.map((c) => c.contract),
      allowFailure: true,
    });

    const ts = Date.now();
    const best = new Map<string, DexQuote>();
    results.forEach((r, i) => {
      if (r.status !== "success") return;
      const c = calls[i];
      const amountOut = Number(r.result[0]) / 10 ** c.outDecimals;
      if (!(amountOut > 0)) return;
      const key = `${c.req.pair}|${c.req.dir}|${c.req.amountIn}`;
      const prev = best.get(key);
      if (!prev || amountOut > prev.amountOut) {
        best.set(key, {
          ts,
          chain: this.chain,
          pair: c.req.pair,
          dir: c.req.dir,
          amountIn: c.req.amountIn,
          amountOut,
          feeTier: c.fee,
        });
      }
    });
    return [...best.values()];
  }
}
