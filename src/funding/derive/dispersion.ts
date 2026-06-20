import { ASSUMED_HOLD_DAYS, FUNDING_PAPER_NOTIONAL, VENUE_TAKER_BPS } from "../config.js";
import type { FundingSnapshot } from "../types.js";
import { impactAt, type BookImpact } from "./impact.js";

// Two delta-neutral carry trades per symbol:
//
//  • perp–perp: short the highest-funding perp venue (receive funding), long
//    the lowest (pay least / receive). Captures the cross-venue funding
//    DIFFERENTIAL. Works for any sign; both legs are perps.
//  • spot-hedge (cash-and-carry): short the highest-funding perp, hedge delta
//    by holding SPOT (0% funding). Captures the venue's ABSOLUTE funding.
//    Only clean when the hot venue's funding is positive.
//
// Modeling spot as a synthetic 0%-funding "venue" makes the two comparable:
//   perp–perp net  = (fundingHi − fundingLo) − fees
//   spot-hedge net = (fundingHi − 0)         − fees
// so spot-hedge wins whenever the cheapest perp leg is still positive (you'd
// rather hold zero-funding spot than pay to be long a perp), and perp–perp
// wins when some venue is negative (you collect on both legs). We compute
// both and pick the better; the flattened fields mirror the winner so every
// downstream consumer (ledger, board, charts) uses the best trade.

export const SPOT = "spot";

const taker = (v: string) => VENUE_TAKER_BPS[v] ?? 5;

// Fill cost (bps) for one leg at the reference size, from measured book depth
// where we have it (impact-from-mid + taker), else flat taker. Spot has no
// book modeled → flat spot taker.
function legBps(
  imp: Map<string, BookImpact>,
  venue: string,
  symbol: string,
  side: "buy" | "sell",
): number {
  const t = taker(venue);
  if (venue === SPOT) return t;
  const x = impactAt(imp.get(`${venue}|${symbol}`), side, FUNDING_PAPER_NOTIONAL);
  return x == null ? t : x + t;
}

// Round-trip fill (entry + exit, both legs) annualized over the assumed hold.
// Uses measured depth at the reference size so the board reflects real
// execution cost, not a flat guess — matching the paper ledger.
function feeAnnPct(
  symbol: string,
  shortVenue: string,
  longVenue: string,
  imp: Map<string, BookImpact>,
): number {
  const roundTripBps =
    legBps(imp, shortVenue, symbol, "sell") + // enter short
    legBps(imp, longVenue, symbol, "buy") + // enter long
    legBps(imp, shortVenue, symbol, "buy") + // exit short
    legBps(imp, longVenue, symbol, "sell"); // exit long
  return (roundTripBps / 100) * (365 / ASSUMED_HOLD_DAYS);
}

export interface Strategy {
  shortVenue: string;
  longVenue: string;
  shortAnnPct: number;
  longAnnPct: number;
  grossAnnPct: number;
  feeAnnPct: number;
  netAnnPct: number;
}

export interface DispersionCell {
  symbol: string;
  // flattened = the winning strategy (so existing consumers keep working)
  shortVenue: string;
  longVenue: string;
  shortAnnPct: number;
  longAnnPct: number;
  grossAnnPct: number;
  feeAnnPct: number;
  netAnnPct: number;
  holdDays: number;
  venuesSeen: number;
  strategy: "perp" | "spot";
  perp: Strategy | null; // perp–perp variant (cross-venue differential)
  spot: Strategy | null; // spot-hedge variant (absolute funding)
}

function strat(
  symbol: string,
  s: { venue: string; ann: number },
  l: { venue: string; ann: number },
  imp: Map<string, BookImpact>,
): Strategy {
  const gross = s.ann - l.ann;
  const fee = feeAnnPct(symbol, s.venue, l.venue, imp);
  return {
    shortVenue: s.venue,
    longVenue: l.venue,
    shortAnnPct: s.ann,
    longAnnPct: l.ann,
    grossAnnPct: gross,
    feeAnnPct: fee,
    netAnnPct: gross - fee,
  };
}

const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Add a synthetic spot leg per symbol (0% funding, mark = median of the real
// venue marks). The ledger consumes the injected set so a spot-hedge position
// can look up its "spot" leg's funding (0) and mark. computeDispersion does
// its own spot handling, so passing injected or raw snaps both work.
export function injectSpot(snaps: FundingSnapshot[]): FundingSnapshot[] {
  const bySym = new Map<string, FundingSnapshot[]>();
  for (const s of snaps) {
    if (s.venue === SPOT) continue;
    (bySym.get(s.symbol) ?? bySym.set(s.symbol, []).get(s.symbol)!).push(s);
  }
  const out = snaps.filter((s) => s.venue !== SPOT);
  for (const [symbol, arr] of bySym) {
    const marks = arr.map((s) => s.markPx).filter((m): m is number => m != null);
    if (!marks.length) continue;
    out.push({
      ts: arr[0].ts,
      venue: SPOT,
      symbol,
      fundingRate: 0,
      intervalHours: 1,
      annualizedPct: 0,
      markPx: median(marks),
    });
  }
  return out;
}

// Best of {perp–perp, spot-hedge} for each symbol at one tick. Pass live
// book impacts to price fills from real depth (else fees fall back to flat).
export function computeDispersion(
  snaps: FundingSnapshot[],
  impacts: BookImpact[] = [],
): DispersionCell[] {
  const imp = new Map<string, BookImpact>();
  for (const i of impacts) imp.set(`${i.venue}|${i.symbol}`, i);
  const bySymbol = new Map<string, FundingSnapshot[]>();
  for (const s of snaps) {
    if (s.venue === SPOT) continue; // recomputed synthetically below
    (bySymbol.get(s.symbol) ?? bySymbol.set(s.symbol, []).get(s.symbol)!).push(s);
  }

  const cells: DispersionCell[] = [];
  for (const [symbol, real] of bySymbol) {
    if (real.length < 1) continue;
    let hi = real[0];
    let lo = real[0];
    for (const s of real) {
      if (s.annualizedPct > hi.annualizedPct) hi = s;
      if (s.annualizedPct < lo.annualizedPct) lo = s;
    }
    const perp =
      real.length >= 2 && hi.venue !== lo.venue
        ? strat(symbol, { venue: hi.venue, ann: hi.annualizedPct }, { venue: lo.venue, ann: lo.annualizedPct }, imp)
        : null;
    // spot-hedge only clean when the hot venue pays positive funding
    const spot =
      hi.annualizedPct > 0
        ? strat(symbol, { venue: hi.venue, ann: hi.annualizedPct }, { venue: SPOT, ann: 0 }, imp)
        : null;
    const candidates = [perp, spot].filter((x): x is Strategy => x !== null);
    if (!candidates.length) continue;
    const winner = candidates.reduce((a, b) => (b.netAnnPct > a.netAnnPct ? b : a));
    cells.push({
      symbol,
      ...winner,
      holdDays: ASSUMED_HOLD_DAYS,
      venuesSeen: real.length,
      strategy: winner === spot ? "spot" : "perp",
      perp,
      spot,
    });
  }
  cells.sort((a, b) => b.netAnnPct - a.netAnnPct);
  return cells;
}
