// One funding observation for a perp on one venue at one tick. Raw rate +
// the venue's funding interval are the source of truth — annualized % is
// derived and recomputable, so a wrong interval assumption is a config fix
// + backfill, never a re-collection.

export interface FundingSnapshot {
  ts: number; // unix ms
  venue: string; // "hyperliquid" | "dydx" | "okx"
  symbol: string; // canonical underlying, e.g. "ETH"
  fundingRate: number; // per-interval rate (raw, signed; +ve = longs pay shorts)
  intervalHours: number; // funding interval this rate applies over
  annualizedPct: number; // fundingRate * (8760 / intervalHours) * 100
  markPx: number | null; // venue mark/oracle price (basis-risk tracking)
}

// A normalized L2 book: price-ascending asks, price-descending bids, each
// level [price, size]. Size is in base units (e.g. ETH), price in USD.
export interface RawBook {
  bids: [number, number][];
  asks: [number, number][];
}

export interface FundingVenue {
  name: string;
  intervalHours: number;
  // Best-effort: returns what it can, logs and skips what it can't.
  poll(symbols: string[]): Promise<FundingSnapshot[]>;
  // Optional L2 book for one symbol — feeds the depth/slippage model.
  fetchBook?(symbol: string): Promise<RawBook | null>;
}

export function annualizedPct(rate: number, intervalHours: number): number {
  return rate * (8760 / intervalHours) * 100;
}
