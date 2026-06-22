export const SIZES_USD = [1_000, 10_000, 100_000, 1_000_000];

// Pairs quoted on every chain that lists both legs; both directions.
// Cross-chain routes only form where the pair exists on both ends —
// single-chain pairs (USDC.e) still record venue-health data.
export const PAIRS: { base: string; quote: string }[] = [
  { base: "USDC", quote: "USDT" },
  { base: "USDC", quote: "DAI" },
  { base: "USDC", quote: "USDe" },
  { base: "USDC", quote: "PYUSD" },
  { base: "USDC", quote: "USDC.e" },
];

// Episode detection thresholds (net bps after cost model)
export const EPISODE_OPEN_BPS = Number(process.env.EPISODE_OPEN_BPS ?? 3);
export const EPISODE_CLOSE_BPS = Number(process.env.EPISODE_CLOSE_BPS ?? 1);

export const POLL_INTERVAL_MS = Number(
  process.env.DELTA_POLL_INTERVAL_MS ?? 60_000,
);

// A swap leg whose price degrades more than this from the smallest size to
// the quoted size is treated as a thin pool (no real liquidity), not a
// tradeable dislocation. Keeps deep depegs, drops empty-pool fantasy.
export const MAX_IMPACT_BPS = Number(process.env.DELTA_MAX_IMPACT_BPS ?? 75);

// Absolute sanity bound on a cross-chain round-trip. A stable/stable cycle
// showing more gross than this is a broken/garbage quote (a single mispriced
// leg routing through an empty pool), not a real dislocation — drop it before
// it reaches the episode catalog or paper ledger. Genuine depegs net far less
// than 2% on a round trip; the leaks we've seen are 25%+ (2500bps).
export const MAX_GROSS_BPS = Number(process.env.DELTA_MAX_GROSS_BPS ?? 200);

export const DB_PATH = process.env.DELTA_DB_PATH ?? "delta.db";

export const PORT = Number(process.env.DELTA_PORT ?? 4747);

export const PUBLIC_DIR = process.env.DELTA_PUBLIC_DIR ?? "public/delta";

export interface EvmToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

export interface EvmChainConfig {
  name: string;
  rpcUrl: string;
  quoterV2: `0x${string}`;
  feeTiers: number[];
  tokens: Record<string, EvmToken>;
}

export const EVM_CHAINS: EvmChainConfig[] = [
  {
    name: "ethereum",
    rpcUrl: process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    feeTiers: [100, 500],
    tokens: {
      USDC: {
        symbol: "USDC",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        decimals: 6,
      },
      USDT: {
        symbol: "USDT",
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        decimals: 6,
      },
      DAI: {
        symbol: "DAI",
        address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        decimals: 18,
      },
      USDe: {
        symbol: "USDe",
        address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
        decimals: 18,
      },
      PYUSD: {
        symbol: "PYUSD",
        address: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8",
        decimals: 6,
      },
    },
  },
  {
    name: "base",
    rpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    feeTiers: [100, 500],
    tokens: {
      USDC: {
        symbol: "USDC",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
      },
      USDT: {
        symbol: "USDT",
        address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
        decimals: 6,
      },
      DAI: {
        symbol: "DAI",
        address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
        decimals: 18,
      },
      USDe: {
        symbol: "USDe",
        address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
        decimals: 18,
      },
    },
  },
  {
    name: "arbitrum",
    rpcUrl: process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    feeTiers: [100, 500],
    tokens: {
      USDC: {
        symbol: "USDC",
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        decimals: 6,
      },
      USDT: {
        symbol: "USDT",
        address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        decimals: 6,
      },
      DAI: {
        symbol: "DAI",
        address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
        decimals: 18,
      },
      USDe: {
        symbol: "USDe",
        address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
        decimals: 18,
      },
      "USDC.e": {
        symbol: "USDC.e",
        address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
        decimals: 6,
      },
    },
  },
];

export const SOLANA_TOKENS: Record<string, { mint: string; decimals: number }> =
  {
    USDC: {
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
    },
    USDT: {
      mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      decimals: 6,
    },
    PYUSD: {
      mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      decimals: 6,
    },
  };

export const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";

export const CHAIN_NAMES = [...EVM_CHAINS.map((c) => c.name), "solana"];
