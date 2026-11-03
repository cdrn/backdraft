import type { Level } from "../types.js";

// Walk a sorted book. Returns null when the book is too thin to fill.

// Sell `qty` base units into bids → USD received.
export function sellInto(bids: Level[], qty: number): number | null {
  let left = qty;
  let usd = 0;
  for (const [px, sz] of bids) {
    const take = Math.min(left, sz);
    usd += take * px;
    left -= take;
    if (left <= 1e-12) return usd;
  }
  return null;
}

// Spend `usd` walking asks → base units received.
export function buyFrom(asks: Level[], usd: number): number | null {
  let left = usd;
  let qty = 0;
  for (const [px, sz] of asks) {
    const cost = px * sz;
    const spend = Math.min(left, cost);
    qty += spend / px;
    left -= spend;
    if (left <= 1e-9) return qty;
  }
  return null;
}

export function mid(bids: Level[], asks: Level[]): number | null {
  if (!bids.length || !asks.length) return null;
  return (bids[0][0] + asks[0][0]) / 2;
}
