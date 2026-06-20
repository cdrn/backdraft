import { ASSUMED_HOLD_DAYS, VENUE_TAKER_BPS } from "../config.js";
import type { FundingSnapshot } from "../types.js";

// The cross-venue carry trade, per symbol: go SHORT the perp on the venue
// with the highest (most positive) funding — you receive funding — and LONG
// the venue with the lowest — you pay least / receive most. Equal notional
// each side ⇒ delta-neutral; income is the funding differential carried each
// interval. Gross is the annualized funding spread; net subtracts the
// round-trip fee (entry+exit on BOTH legs) amortized over an assumed hold,
// because a spread you can't hold long enough to out-earn the fills is not
// money.

export interface DispersionCell {
  symbol: string;
  shortVenue: string; // short here (highest funding)
  longVenue: string; // long here (lowest funding)
  shortAnnPct: number;
  longAnnPct: number;
  grossAnnPct: number; // shortAnnPct - longAnnPct (>= 0)
  feeAnnPct: number; // round-trip fee amortized over ASSUMED_HOLD_DAYS
  netAnnPct: number; // grossAnnPct - feeAnnPct
  holdDays: number;
  venuesSeen: number; // how many venues priced this symbol this tick
}

function feeAnnPct(shortVenue: string, longVenue: string): number {
  const taker = (v: string) => VENUE_TAKER_BPS[v] ?? 5;
  // enter + exit on each leg = 2 * (takerShort + takerLong) bps, one-time.
  const roundTripBps = 2 * (taker(shortVenue) + taker(longVenue));
  // amortize the one-time bps over the hold, then annualize.
  return (roundTripBps / 100) * (365 / ASSUMED_HOLD_DAYS);
}

// Best (widest net) cross-venue pair for each symbol at one tick.
export function computeDispersion(snaps: FundingSnapshot[]): DispersionCell[] {
  const bySymbol = new Map<string, FundingSnapshot[]>();
  for (const s of snaps) {
    const arr = bySymbol.get(s.symbol) ?? [];
    arr.push(s);
    bySymbol.set(s.symbol, arr);
  }

  const cells: DispersionCell[] = [];
  for (const [symbol, arr] of bySymbol) {
    if (arr.length < 2) continue; // need two venues to form a pair
    let hi = arr[0];
    let lo = arr[0];
    for (const s of arr) {
      if (s.annualizedPct > hi.annualizedPct) hi = s;
      if (s.annualizedPct < lo.annualizedPct) lo = s;
    }
    if (hi.venue === lo.venue) continue;
    const grossAnnPct = hi.annualizedPct - lo.annualizedPct;
    const fee = feeAnnPct(hi.venue, lo.venue);
    cells.push({
      symbol,
      shortVenue: hi.venue,
      longVenue: lo.venue,
      shortAnnPct: hi.annualizedPct,
      longAnnPct: lo.annualizedPct,
      grossAnnPct,
      feeAnnPct: fee,
      netAnnPct: grossAnnPct - fee,
      holdDays: ASSUMED_HOLD_DAYS,
      venuesSeen: arr.length,
    });
  }
  cells.sort((a, b) => b.netAnnPct - a.netAnnPct);
  return cells;
}
