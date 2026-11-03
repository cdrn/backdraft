// Shared types for the spread module (cross-venue realizable-spread logger).

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

// One executable DEX quote: exact-input through the best pool on one DEX.
// `dex` is the venue id ("base/uni", "arbitrum/camelot"); `chain` is
// redundant with it but kept for grouping.
export interface DexQuote {
  ts: number;
  chain: string;
  dex: string;
  pair: string; // "ETH", "BTC", "AERO" — the base asset
  dir: "buy" | "sell"; // buy = USDC→base, sell = base→USDC
  amountIn: number; // USDC (buy) or base units (sell)
  amountOut: number; // base units (buy) or USDC (sell)
  feeTier: number; // fee (uni-style) or tick spacing (slipstream); 0 = single pool
}

// Which legs a cell crosses. dex→dex is same-chain and atomic (one tx, no
// inventory); the other three carry inventory across venues.
export type Kind = "dex→cex" | "cex→dex" | "dex→dex" | "cex→cex";
export const KINDS: Kind[] = ["dex→cex", "cex→dex", "dex→dex", "cex→cex"];

// Venue ids: a CEX is its name ("coinbase"); a DEX is "<chain>/<dex>".
export function isDexVenue(v: string): boolean {
  return v.includes("/");
}
export function chainOf(dexVenue: string): string {
  return dexVenue.slice(0, dexVenue.indexOf("/"));
}

// One cell of the board: buy `pair` on `buy`, sell it on `sell`, at `size`
// USD in, with the full cost decomposition. `route` is the stable key the
// episode detector, paper ledger and dashboard group by.
export interface Cell {
  ts: number;
  pair: string;
  kind: Kind;
  buy: string; // venue id the asset is bought on
  sell: string; // venue id the asset is sold on
  route: string; // "ETH base/uni→coinbase"
  size: number; // USD notional in
  buyPx: number; // effective USD per base unit on the buy leg
  sellPx: number; // effective USD per base unit on the sell leg
  grossBps: number; // (usdOut / usdIn - 1) * 1e4, before outside costs
  feeBps: number; // CEX fee(s)
  gasBps: number; // DEX gas amortised at this size
  rebalBps: number; // inventory rebalance amortised per clip
  costBps: number;
  netBps: number;
  netUsd: number;
}

export function routeKey(pair: string, buy: string, sell: string): string {
  return `${pair} ${buy}→${sell}`;
}

export function kindOf(buy: string, sell: string): Kind {
  const b = isDexVenue(buy);
  const s = isDexVenue(sell);
  if (b && s) return "dex→dex";
  if (b) return "dex→cex";
  if (s) return "cex→dex";
  return "cex→cex";
}
