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

// Keep only the levels a clip walk can reach: cumulative notional up to
// `usdCap` (plus the level that crosses it), never fewer than `minLevels`.
// Coinbase's level-2 book is the whole aggregated book — 100 KB per pull —
// and storing it raw filled a 24 GB disk in two days.
export function trimLevels(levels: Level[], usdCap: number, minLevels = 20): Level[] {
  let usd = 0;
  for (let i = 0; i < levels.length; i++) {
    usd += levels[i][0] * levels[i][1];
    if (usd >= usdCap && i + 1 >= minLevels) return levels.slice(0, i + 1);
  }
  return levels;
}
