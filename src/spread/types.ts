// Shared types for the spread module (CEX↔DEX realizable-spread logger).

// A price level: [price, size in base units].
export type Level = [number, number];

export interface Book {
  ts: number;
  venue: string;
  symbol: string; // venue-native symbol, e.g. "ETH-USDC"
  bids: Level[]; // sorted desc by price
  asks: Level[]; // sorted asc by price
}

export interface SpotVenue {
  name: string;
  // Fetch the top-of-book depth for one pair. Null when the venue doesn't
  // list it; throws on transport errors.
  fetchBook(symbol: string): Promise<Book | null>;
}

// One executable DEX quote: exact-input through the deepest fee tier.
export interface DexQuote {
  ts: number;
  chain: string;
  pair: string; // "ETH", "BTC" — the base asset
  dir: "buy" | "sell"; // buy = USDC→base, sell = base→USDC
  amountIn: number; // USDC (buy) or base units (sell)
  amountOut: number; // base units (buy) or USDC (sell)
  feeTier: number;
}

export type Direction = "dex→cex" | "cex→dex";

// One cell of the board: a (pair, chain, cex, direction, size) tuple with the
// full cost decomposition. `route` is the stable key the episode detector,
// paper ledger and dashboard group by.
export interface Cell {
  ts: number;
  pair: string;
  chain: string;
  cex: string;
  dir: Direction;
  route: string; // "ETH base→coinbase" | "ETH coinbase→base"
  size: number; // USD notional in
  dexPx: number; // effective USDC per base unit on the DEX leg
  cexPx: number; // effective USDC per base unit on the CEX leg
  grossBps: number; // (usdOut / usdIn - 1) * 1e4, before fees
  feeBps: number; // CEX fee
  gasBps: number; // DEX gas amortised at this size
  rebalBps: number; // inventory rebalance amortised per clip
  costBps: number;
  netBps: number;
  netUsd: number;
}

export function routeKey(
  pair: string,
  chain: string,
  cex: string,
  dir: Direction,
): string {
  return dir === "dex→cex" ? `${pair} ${chain}→${cex}` : `${pair} ${cex}→${chain}`;
}
