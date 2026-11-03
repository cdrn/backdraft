// Spread — CEX↔DEX realizable-spread logger.
//
// The question this module answers: at MY latency tier, with MY fee tier, how
// often is the CEX↔DEX spread on a liquid pair positive after every cost, for
// how long, and how much of it survives the lag between seeing it and landing
// it? Everything is env-tunable because the honest answer depends on the
// operator's exchange fee tier and node placement, not on the market.

import { arbitrum, base, type Chain } from "viem/chains";

export const DB_PATH = process.env.SPREAD_DB_PATH ?? "spread.db";
export const PORT = Number(process.env.SPREAD_PORT ?? 4749);
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

// Episode hysteresis (net bps after costs).
export const EPISODE_OPEN_BPS = Number(process.env.SPREAD_EPISODE_OPEN_BPS ?? 5);
export const EPISODE_CLOSE_BPS = Number(process.env.SPREAD_EPISODE_CLOSE_BPS ?? 1);

// Sanity bound. A liquid-pair CEX↔DEX round trip showing more than this gross
// is a broken quote (stale book, empty tier), not a dislocation.
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
  quoterV2: `0x${string}`;
  feeTiers: number[];
  usdc: EvmToken;
  gasUsdPerSwap: number; // conservative, editable
}

// Quoting goes through Uniswap V3 QuoterV2 on keyless public RPCs. Every
// (pair × direction × size × tier) quote for a chain is packed into ONE
// Multicall3 eth_call per tick, so the RPC load is one request per chain
// per tick regardless of how many sizes we track.
export const CHAINS: ChainConfig[] = [
  {
    name: "base",
    chain: base,
    rpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    feeTiers: [500, 3000, 100],
    usdc: {
      symbol: "USDC",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
    },
    gasUsdPerSwap: Number(process.env.SPREAD_GAS_USD_BASE ?? 0.05),
  },
  {
    name: "arbitrum",
    chain: arbitrum,
    rpcUrl: process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    feeTiers: [500, 3000, 100],
    usdc: {
      symbol: "USDC",
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      decimals: 6,
    },
    gasUsdPerSwap: Number(process.env.SPREAD_GAS_USD_ARBITRUM ?? 0.05),
  },
];

export interface PairConfig {
  pair: string; // base asset label
  tokens: Record<string, EvmToken>; // per chain name
  cex: Record<string, string>; // per venue: native symbol
}

// Coinbase unified its USD and USDC books in 2023 and delisted the *-USDC
// products; USD↔USDC conversion there is 1:1 and free, so the *-USD book IS
// the USDC book. OKX and Binance quote USDC natively.
//
// Addresses verified against the canonical deployments (Base WETH predeploy,
// Coinbase cbBTC, Arbitrum WETH/WBTC bridge tokens). NB: cbBTC/WBTC trade
// against spot BTC on the CEX leg — redemption to native BTC is 1:1 but is a
// separate step with its own queue, so a BTC "spread" here is also a wrapper
// basis. ETH is the clean one.
export const PAIRS: PairConfig[] = [
  {
    pair: "ETH",
    tokens: {
      base: {
        symbol: "WETH",
        address: "0x4200000000000000000000000000000000000006",
        decimals: 18,
      },
      arbitrum: {
        symbol: "WETH",
        address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        decimals: 18,
      },
    },
    cex: { coinbase: "ETH-USD", okx: "ETH-USDC", binance: "ETHUSDC" },
  },
  {
    pair: "BTC",
    tokens: {
      base: {
        symbol: "cbBTC",
        address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
        decimals: 8,
      },
      arbitrum: {
        symbol: "WBTC",
        address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
        decimals: 8,
      },
    },
    cex: { coinbase: "BTC-USD", okx: "BTC-USDC", binance: "BTCUSDC" },
  },
];

// ---- inventory rebalance ----
// After a clip you're long the asset on one venue and long USDC on the other.
// Re-arming means a CEX withdrawal + on-chain deposit (or waiting for the
// spread to flip). Modelled as a fixed cost paid once per N clips.
export const REBALANCE_FIXED_USD = Number(process.env.SPREAD_REBALANCE_USD ?? 3);
export const CLIPS_PER_REBALANCE = Number(process.env.SPREAD_CLIPS_PER_REBALANCE ?? 10);

export const CHAIN_NAMES = CHAINS.map((c) => c.name);
