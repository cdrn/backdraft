import type { RawBook } from "../types.js";

// Depth / slippage model. Walks the real L2 book to answer the only question
// the flat taker-bps table couldn't: what does it actually COST to put size on
// here? Impact is measured from mid, so it already includes the half-spread
// you cross plus the depth you eat — the dominant round-trip cost on thin
// venues. A size the book can't fill returns null ("too thin"), which is
// itself the signal: the venue can't absorb that notional.

// Notional buckets (USD) we measure fill cost at.
export const IMPACT_SIZES = [1_000, 10_000, 100_000];

export interface BookImpact {
  ts: number;
  venue: string;
  symbol: string;
  midPx: number | null;
  spreadBps: number | null;
  // bps from mid to fill the bucket; null = book too thin for that size.
  buyBps: (number | null)[]; // aligned to IMPACT_SIZES
  sellBps: (number | null)[];
}

// VWAP impact (bps from mid, >=0) to fill `notionalUsd` by sweeping levels.
// buy sweeps asks, sell sweeps bids. null if the book can't fill the size.
function fillImpactBps(
  levels: [number, number][],
  mid: number,
  notionalUsd: number,
  side: "buy" | "sell",
): number | null {
  let remaining = notionalUsd;
  let cost = 0; // USD spent
  let qty = 0; // base filled
  for (const [px, sz] of levels) {
    const levelUsd = px * sz;
    const take = Math.min(levelUsd, remaining);
    qty += take / px;
    cost += take;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 1e-6 || qty === 0) return null; // book too thin
  const vwap = cost / qty;
  const bps = side === "buy" ? (vwap / mid - 1) * 10_000 : (1 - vwap / mid) * 10_000;
  return Math.max(0, bps);
}

export function computeImpact(
  book: RawBook,
  venue: string,
  symbol: string,
  ts: number,
): BookImpact {
  // defensive: best-first regardless of how the venue ordered them.
  const bids = [...book.bids].sort((a, b) => b[0] - a[0]);
  const asks = [...book.asks].sort((a, b) => a[0] - b[0]);
  book = { bids, asks };
  const bestBid = book.bids[0]?.[0];
  const bestAsk = book.asks[0]?.[0];
  const mid =
    bestBid !== undefined && bestAsk !== undefined
      ? (bestBid + bestAsk) / 2
      : null;
  const spreadBps =
    mid && bestBid && bestAsk ? (bestAsk / bestBid - 1) * 10_000 : null;
  const buyBps = IMPACT_SIZES.map((n) =>
    mid ? fillImpactBps(book.asks, mid, n, "buy") : null,
  );
  const sellBps = IMPACT_SIZES.map((n) =>
    mid ? fillImpactBps(book.bids, mid, n, "sell") : null,
  );
  return { ts, venue, symbol, midPx: mid, spreadBps, buyBps, sellBps };
}

// Look up impact (bps) to trade `notionalUsd` on a side, using the smallest
// bucket that covers it (clamped to the largest). null if unknown/too thin.
export function impactAt(
  imp: BookImpact | undefined,
  side: "buy" | "sell",
  notionalUsd: number,
): number | null {
  if (!imp) return null;
  let idx = IMPACT_SIZES.findIndex((s) => s >= notionalUsd);
  if (idx === -1) idx = IMPACT_SIZES.length - 1; // bigger than all buckets
  return (side === "buy" ? imp.buyBps : imp.sellBps)[idx] ?? null;
}
