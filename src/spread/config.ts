// Spread — cross-venue realizable-spread logger.
//
// The question this module answers: at MY latency tier, with MY fee tier, how
// often is the spread between two venues on the same asset positive after
// every cost, for how long, and how much of it survives the lag between
// seeing it and landing it? Four kinds of route:
//
//   dex→cex / cex→dex   the CEX↔DEX inventory trade
//   dex→dex             same-chain, atomic (one tx, no inventory, no latency
//                       tax beyond the block) — the searcher's trade
//   cex→cex             two CEX books, a control for where the edge lives
//
// Everything is env-tunable because the honest answer depends on the
// operator's exchange fee tier and node placement, not on the market.

import { arbitrum, base, type Chain } from "viem/chains";
import { KINDS, type Kind } from "./types.js";

// Raw rows (books, quotes) and cells older than this are pruned hourly.
// Episodes and paper entries are kept. ~450 MB/day at the default venue set.
export const RETENTION_DAYS = Number(process.env.SPREAD_RETENTION_DAYS ?? 21);
export const DB_PATH = process.env.SPREAD_DB_PATH ?? "spread.db";
export const PORT = Number(process.env.SPREAD_PORT ?? 4750);
export const PUBLIC_DIR = process.env.SPREAD_PUBLIC_DIR ?? "public/spread";

// 10s default: fast enough to see a dislocation form and decay, slow enough
// that keyless public RPCs and exchange REST books never throttle us. The
// paper ledger measures the latency tax in multiples of this.
export const POLL_INTERVAL_MS = Number(
  process.env.SPREAD_POLL_INTERVAL_MS ?? 10_000,
);

// How late a non-colocated operator lands: the paper ledger re-prices every
// entry this long after it was quoted. Default one tick.
export const LATENCY_MS = Number(process.env.SPREAD_LATENCY_MS ?? POLL_INTERVAL_MS);

export const SIZES_USD: number[] = (process.env.SPREAD_SIZES ?? "5000,25000,100000")
  .split(",")
  .map(Number)
  .filter((n) => n > 0);

// Which route kinds to compute. Default all four.
export const ROUTE_KINDS: Kind[] = (process.env.SPREAD_KINDS ?? KINDS.join(","))
  .split(",")
  .map((s) => s.trim() as Kind)
  .filter((k) => KINDS.includes(k));

// Episode hysteresis (net bps after costs).
export const EPISODE_OPEN_BPS = Number(process.env.SPREAD_EPISODE_OPEN_BPS ?? 5);
export const EPISODE_CLOSE_BPS = Number(process.env.SPREAD_EPISODE_CLOSE_BPS ?? 1);

// Sanity bound. A liquid-pair round trip showing more than this gross is a
// broken quote (stale book, empty tier), not a dislocation. Mid-caps on thin
// pools can legitimately show more, so it's per-pair overridable below.
export const MAX_GROSS_BPS = Number(process.env.SPREAD_MAX_GROSS_BPS ?? 300);

// ---- CEX side ----

// Default venues are the ones reachable from a US IP. Binance.com returns
// HTTP 451 from the US; opt in with SPREAD_CEX=coinbase,okx,binance when
// running from elsewhere.
export const CEX_VENUES: string[] = (process.env.SPREAD_CEX ?? "coinbase,okx")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// One-way CEX fee in bps of notional. Defaults are the PESSIMAL base tiers;
// this is the single biggest knob in the whole model. Coinbase Advanced at
// <$1M/mo volume is 40–75 bps taker; the firms that actually run CEX↔DEX arb
// pay 0–2 bps. Set these to your real tier or the board is fiction.
export const CEX_EXEC: "taker" | "maker" =
  (process.env.SPREAD_CEX_EXEC as "taker" | "maker") ?? "taker";
export const CEX_TAKER_BPS: Record<string, number> = {
  coinbase: Number(process.env.SPREAD_TAKER_BPS_COINBASE ?? 40),
  okx: Number(process.env.SPREAD_TAKER_BPS_OKX ?? 10),
  binance: Number(process.env.SPREAD_TAKER_BPS_BINANCE ?? 10),
};
export const CEX_MAKER_BPS: Record<string, number> = {
  coinbase: Number(process.env.SPREAD_MAKER_BPS_COINBASE ?? 10),
  okx: Number(process.env.SPREAD_MAKER_BPS_OKX ?? 8),
  binance: Number(process.env.SPREAD_MAKER_BPS_BINANCE ?? 10),
};
// Resting a maker order instead of crossing: no book impact, but you get
// filled only when price comes to you — an adverse-selection haircut.
export const MAKER_ADVERSE_BPS = Number(process.env.SPREAD_MAKER_ADVERSE_BPS ?? 3);

// ---- DEX side ----

export interface EvmToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

export interface ChainConfig {
  name: string;
  chain: Chain; // viem chain (for Multicall3 address)
  rpcUrl: string;
  usdc: EvmToken;
  gasUsdPerSwap: number; // conservative, editable
  // Calldata bytes per Multicall3 chunk. Public RPCs cap eth_call gas and a
  // deep-pool quote is 100k–1M gas; Arbitrum's cap bites at ~10 quotes.
  multicallBatchBytes: number;
}

// Quoter flavours we know how to call. All four return amountOut as the
// first word and revert-and-catch internally, so a failed tier is just a
// failed multicall slot, never a failed tick.
//   univ3       Uniswap V3 QuoterV2 ABI (also PancakeSwap V3, Sushi V3)
//   slipstream  Aerodrome/Velodrome CL — QuoterV2 with int24 tickSpacing
//   algebra     Camelot V3 — single pool per pair, no tier
//   univ4       Uniswap V4 Quoter — PoolKey (fee, tickSpacing), native ETH
export type QuoterKind = "univ3" | "slipstream" | "algebra" | "univ4";

export interface DexConfig {
  id: string; // "<chain>/<dex>" — the venue id in routes
  chain: string;
  label: string;
  kind: QuoterKind;
  quoter: `0x${string}`;
  tiers: number[]; // fee tiers / tick spacings to try; algebra ignores
}

// Quoting goes through each DEX's quoter contract on keyless public RPCs.
// Every (dex × pair × direction × size × live tier) quote for a chain is
// packed into Multicall3 eth_calls, chunked so one call stays well under the
// public RPC gas cap. Tiers are discovered at startup (and hourly) so dead
// tiers cost nothing per tick.
export const CHAINS: ChainConfig[] = [
  {
    name: "base",
    chain: base,
    rpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    usdc: {
      symbol: "USDC",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
    },
    gasUsdPerSwap: Number(process.env.SPREAD_GAS_USD_BASE ?? 0.05),
    multicallBatchBytes: 4096,
  },
  {
    name: "arbitrum",
    chain: arbitrum,
    rpcUrl: process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    usdc: {
      symbol: "USDC",
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      decimals: 6,
    },
    gasUsdPerSwap: Number(process.env.SPREAD_GAS_USD_ARBITRUM ?? 0.05),
    multicallBatchBytes: 1024,
  },
];

// Quoter addresses verified 2026-11-02 by calling each with 1 WETH→USDC and
// checking the price against Uniswap V3 (see git log). They must be EIP-55
// checksummed: viem rejects a mixed-case address with a wrong checksum
// (cast doesn't, so a cast-verified address can still fail here). Uniswap
// V4 quotes native ETH (currency 0x0), handled in the quoter.
const ALL_DEXES: DexConfig[] = [
  // ---- Base ----
  {
    id: "base/uni",
    chain: "base",
    label: "Uniswap V3",
    kind: "univ3",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    tiers: [100, 500, 3000, 10000],
  },
  {
    id: "base/aero",
    chain: "base",
    label: "Aerodrome CL",
    kind: "slipstream",
    quoter: "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0",
    tiers: [1, 50, 100, 200, 2000],
  },
  {
    id: "base/pcs",
    chain: "base",
    label: "PancakeSwap V3",
    kind: "univ3",
    quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    tiers: [100, 500, 2500, 10000],
  },
  {
    id: "base/v4",
    chain: "base",
    label: "Uniswap V4",
    kind: "univ4",
    quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    tiers: [100, 500, 3000, 10000], // tickSpacing derived in the quoter
  },
  // ---- Arbitrum ----
  {
    id: "arbitrum/uni",
    chain: "arbitrum",
    label: "Uniswap V3",
    kind: "univ3",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    tiers: [100, 500, 3000, 10000],
  },
  {
    id: "arbitrum/camelot",
    chain: "arbitrum",
    label: "Camelot V3",
    kind: "algebra",
    quoter: "0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E",
    tiers: [0],
  },
  {
    id: "arbitrum/pcs",
    chain: "arbitrum",
    label: "PancakeSwap V3",
    kind: "univ3",
    quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    tiers: [100, 500, 2500, 10000],
  },
  {
    id: "arbitrum/sushi",
    chain: "arbitrum",
    label: "Sushi V3",
    kind: "univ3",
    quoter: "0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1",
    tiers: [100, 500, 3000, 10000],
  },
  {
    id: "arbitrum/v4",
    chain: "arbitrum",
    label: "Uniswap V4",
    kind: "univ4",
    quoter: "0x3972C00f7ed4885e145823eb7C655375d275A1C5",
    tiers: [100, 500, 3000, 10000],
  },
];

// SPREAD_DEXES=base/uni,base/aero,... to narrow. Default all.
const dexFilter = (process.env.SPREAD_DEXES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const DEXES: DexConfig[] = dexFilter.length
  ? ALL_DEXES.filter((d) => dexFilter.includes(d.id))
  : ALL_DEXES;

export interface PairConfig {
  pair: string; // base asset label
  tokens: Record<string, EvmToken>; // per chain name
  cex: Record<string, string>; // per venue: native symbol
  maxGrossBps?: number; // override of MAX_GROSS_BPS for thin pairs
}

// Coinbase unified its USD and USDC books in 2023 and delisted the *-USDC
// products; USD↔USDC conversion there is 1:1 and free, so the *-USD book IS
// the USDC book. OKX and Binance quote USDC natively.
//
// Addresses verified against the canonical deployments by reading symbol()
// and decimals() on chain (2026-11-02). NB: cbBTC/WBTC trade against spot
// BTC on the CEX leg — redemption to native BTC is 1:1 but is a separate
// step with its own queue, so a BTC "spread" here is also a wrapper basis.
// ETH is the clean one.
//
// Mid-caps are where retail CEX↔DEX arb actually happens: thin pools, CEX
// books that lag. Every pair needs at least one CEX listing (the CEX mid is
// the reference price the DEX quotes are sized off). A pair with no pool on
// a DEX simply yields no quotes there.
const ALL_PAIRS: PairConfig[] = [
  {
    pair: "ETH",
    tokens: {
      base: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      arbitrum: { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
    },
    cex: { coinbase: "ETH-USD", okx: "ETH-USDC", binance: "ETHUSDC" },
  },
  {
    pair: "BTC",
    tokens: {
      base: { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
      arbitrum: { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8 },
    },
    cex: { coinbase: "BTC-USD", okx: "BTC-USDC", binance: "BTCUSDC" },
  },
  // ---- Base mid-caps ----
  {
    // AERO migrated contracts in Nov 2026 (old 0x9401…8631 "Aerodrome" → new
    // "Aero", 1:1). CEXes price the new token; the old one kept trading on
    // chain at a premium with no deposit bridge, which read as a fake +250 bps
    // episode. Quote the new contract; it has no cells until liquidity moves.
    pair: "AERO",
    tokens: {
      base: { symbol: "AERO", address: "0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee", decimals: 18 },
    },
    cex: { coinbase: "AERO-USD" },
    maxGrossBps: 1000,
  },
  {
    pair: "VIRTUAL",
    tokens: {
      base: { symbol: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", decimals: 18 },
    },
    cex: { coinbase: "VIRTUAL-USD", okx: "VIRTUAL-USDC" },
    maxGrossBps: 1000,
  },
  {
    pair: "DEGEN",
    tokens: {
      base: { symbol: "DEGEN", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", decimals: 18 },
    },
    cex: { coinbase: "DEGEN-USD", okx: "DEGEN-USDC" },
    maxGrossBps: 1000,
  },
  // ---- Arbitrum mid-caps ----
  {
    pair: "ARB",
    tokens: {
      arbitrum: { symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },
    },
    cex: { coinbase: "ARB-USD", okx: "ARB-USDC" },
    maxGrossBps: 1000,
  },
  {
    pair: "LINK",
    tokens: {
      arbitrum: { symbol: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18 },
    },
    cex: { coinbase: "LINK-USD", okx: "LINK-USDC" },
    maxGrossBps: 1000,
  },
  {
    pair: "PENDLE",
    tokens: {
      arbitrum: { symbol: "PENDLE", address: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8", decimals: 18 },
    },
    cex: { coinbase: "PENDLE-USD", okx: "PENDLE-USDC" },
    maxGrossBps: 1000,
  },
  {
    pair: "UNI",
    tokens: {
      arbitrum: { symbol: "UNI", address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0", decimals: 18 },
    },
    cex: { coinbase: "UNI-USD", okx: "UNI-USDC" },
    maxGrossBps: 1000,
  },
];

// SPREAD_PAIRS=ETH,BTC to narrow. Default all.
const pairFilter = (process.env.SPREAD_PAIRS ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
export const PAIRS: PairConfig[] = pairFilter.length
  ? ALL_PAIRS.filter((p) => pairFilter.includes(p.pair))
  : ALL_PAIRS;

// ---- inventory rebalance ----
// After a non-atomic clip you're long the asset on one venue and long USDC
// on the other. Re-arming means a withdrawal + deposit (or waiting for the
// spread to flip). Modelled as a fixed cost paid once per N clips. dex→dex
// is atomic and pays none of this.
export const REBALANCE_FIXED_USD = Number(process.env.SPREAD_REBALANCE_USD ?? 3);
export const CLIPS_PER_REBALANCE = Number(process.env.SPREAD_CLIPS_PER_REBALANCE ?? 10);

// Atomic dex→dex clips compete in the builder auction: whatever you don't
// tip, someone else will. Modelled as a flat bps haircut, default 0 so the
// board shows the raw gap; set it to what the winning bundles actually pay.
export const ATOMIC_TIP_BPS = Number(process.env.SPREAD_ATOMIC_TIP_BPS ?? 0);

export const CHAIN_NAMES = CHAINS.map((c) => c.name);
export const DEX_IDS = DEXES.map((d) => d.id);
