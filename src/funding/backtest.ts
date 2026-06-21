// Backtest the cross-venue carry strategy on REAL historical realized funding.
//
// Pulls ~20d of realized funding from HL (hourly), OKX (8h), dYdX (hourly) for
// every tracked symbol, aligns to an hourly grid, injects synthetic spot (0%),
// and simulates the actual strategy: at each hour pick the best pair
// (perp–perp or spot-hedge), open when net annualized at the assumed hold
// clears the threshold, accrue the REALIZED hourly funding differential, pay a
// one-time round-trip fill, close on sustained compression or max hold.
//
// HONEST LIMITS:
//  • Fill cost is a FIXED bps assumption (no historical order-book depth) —
//    swept across a maker-ish and a conservative value. Real thin-venue fills
//    can be worse; treat positive results as a ceiling.
//  • Paradex excluded (its history feed is 5s-granular, impractical to
//    backfill) — so dispersion involving Paradex is understated here.
//  • Realized funding IS real (what was actually paid), not predicted — the
//    one thing we most wanted to get right.

import "dotenv/config";
import { SYMBOLS } from "./config.js";

const DAYS = Number(process.env.BT_DAYS ?? 20);
const HOLDS = [1, 3, 7, 14]; // hold-length sweep (days)
const ROUNDTRIP_BPS = [12, 20]; // fill-cost sweep: maker-ish vs conservative blend
const OPEN_PCT = Number(process.env.BT_OPEN_PCT ?? 10);
const HOUR = 3_600_000;
const NOTIONAL = 10_000;
const now = Date.now();
const startMs = now - DAYS * 86_400_000;

type Series = Map<number, number>; // hourBucket -> annualizedPct
const hourBucket = (ts: number) => Math.floor(ts / HOUR);

async function hlSeries(sym: string): Promise<Series> {
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "fundingHistory", coin: sym, startTime: startMs }),
  });
  const rows = (await r.json()) as { time: number; fundingRate: string }[];
  const s: Series = new Map();
  for (const x of rows) s.set(hourBucket(x.time), Number(x.fundingRate) * 8760 * 100);
  return s;
}

async function dydxSeries(sym: string): Promise<Series> {
  // paginate backward via effectiveBeforeOrAt to reach ~the window
  const s: Series = new Map();
  let before: string | undefined;
  for (let i = 0; i < 5; i++) {
    const url = new URL(`https://indexer.dydx.trade/v4/historicalFunding/${sym}-USD`);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("effectiveBeforeOrAt", before);
    const r = await fetch(url);
    if (!r.ok) break;
    const rows = ((await r.json()) as { historicalFunding: { effectiveAt: string; rate: string }[] }).historicalFunding;
    if (!rows.length) break;
    for (const x of rows) {
      const t = Date.parse(x.effectiveAt);
      if (t >= startMs) s.set(hourBucket(t), Number(x.rate) * 8760 * 100);
    }
    const oldest = Date.parse(rows[rows.length - 1].effectiveAt);
    if (oldest < startMs) break;
    before = rows[rows.length - 1].effectiveAt;
  }
  return s;
}

async function okxSeries(sym: string): Promise<Series> {
  const r = await fetch(
    `https://www.okx.com/api/v5/public/funding-rate-history?instId=${sym}-USDT-SWAP&limit=100`,
  );
  const rows = ((await r.json()) as { data?: { fundingTime: string; fundingRate: string }[] }).data ?? [];
  // OKX rate is per-8h; it applies across the 8 hours up to fundingTime.
  // forward-fill across each 8h block into the hourly grid.
  const s: Series = new Map();
  for (const x of rows) {
    const ann = Number(x.fundingRate) * (8760 / 8) * 100;
    const end = Number(x.fundingTime);
    for (let h = 0; h < 8; h++) s.set(hourBucket(end - h * HOUR), ann);
  }
  return s;
}

interface Trade { symbol: string; openTs: number; holdH: number; net: number; carry: number; fee: number; }

function simulate(
  perVenue: Record<string, Series>, // venue -> series for ONE symbol
  symbol: string,
  holdDays: number,
  roundtripBps: number,
  persistH = 0, // require the best-pair gross spread to have held above the
                // open gate for this many trailing hours before entering
                // (0 = spike entry; >0 = persistent-dispersion entry)
): Trade[] {
  const venues = Object.keys(perVenue);
  const allHours = new Set<number>();
  for (const v of venues) for (const h of perVenue[v].keys()) allHours.add(h);
  const hours = [...allHours].sort((a, b) => a - b);
  const holdH = holdDays * 24;
  const feeUsd = (roundtripBps / 10_000) * NOTIONAL;
  // annualized fee drag for the open gate (matches live board math)
  const feeAnn = (roundtripBps / 100) * (365 / holdDays);

  const trades: Trade[] = [];
  let openUntil = -1; // hour index until which we're in a position (no overlap per symbol)

  for (const h of hours) {
    if (h < openUntil) continue;
    // rates available this hour (forward-fill within 8h handled for OKX already)
    const rates: { venue: string; ann: number }[] = [];
    for (const v of venues) { const a = perVenue[v].get(h); if (a !== undefined) rates.push({ venue: v, ann: a }); }
    rates.push({ venue: "spot", ann: 0 }); // synthetic hedge leg
    if (rates.length < 2) continue;
    let hi = rates[0], lo = rates[0];
    for (const r of rates) { if (r.ann > hi.ann) hi = r; if (r.ann < lo.ann) lo = r; }
    if (hi.venue === lo.venue) continue;
    const grossAnn = hi.ann - lo.ann;
    if (grossAnn - feeAnn < OPEN_PCT) continue; // open gate (net clears threshold)

    // persistence gate: require the gate to have ALSO held over the trailing
    // window (same hi/lo venues), i.e. enter on durable dispersion not a spike.
    if (persistH > 0) {
      let held = true;
      for (let k = 1; k <= persistH; k++) {
        const s = perVenue[hi.venue]?.get(h - k);
        const l = lo.venue === "spot" ? 0 : perVenue[lo.venue]?.get(h - k);
        if (s === undefined || l === undefined || s - l - feeAnn < OPEN_PCT) { held = false; break; }
      }
      if (!held) continue;
    }

    // OPEN: short hi, long lo. accrue realized hourly differential over the hold.
    let carry = 0;
    let closedAt = h + holdH;
    for (let k = 0; k < holdH; k++) {
      const hh = h + k;
      const s = perVenue[hi.venue]?.get(hh);
      const l = lo.venue === "spot" ? 0 : perVenue[lo.venue]?.get(hh);
      if (s === undefined || l === undefined) continue; // missing data → skip hour
      carry += NOTIONAL * ((s - l) / 100) * (1 / 8760);
      // early close if the spread flips clearly negative (edge gone)
      if (s - l < 0 && k >= 6) { closedAt = hh; break; }
    }
    const net = carry - feeUsd;
    trades.push({ symbol, openTs: h * HOUR, holdH: closedAt - h, net, carry, fee: feeUsd });
    openUntil = closedAt; // no overlapping position in the same symbol
  }
  return trades;
}

async function main() {
  console.log(`Backtest — ${DAYS}d of realized funding, ${SYMBOLS.length} symbols, HL+dYdX+OKX (+spot)\n`);
  // fetch all venues for all symbols
  const data: Record<string, Record<string, Series>> = {}; // symbol -> venue -> series
  for (const sym of SYMBOLS) {
    const [hl, dy, ok] = await Promise.all([
      hlSeries(sym).catch(() => new Map()),
      dydxSeries(sym).catch(() => new Map()),
      okxSeries(sym).catch(() => new Map()),
    ]);
    data[sym] = { hyperliquid: hl, dydx: dy, okx: ok };
    process.stdout.write(`  ${sym}: HL=${hl.size} dYdX=${dy.size} OKX=${ok.size}h\n`);
  }

  for (const persistH of [0, 24]) {
    console.log(`\n=== entry: ${persistH === 0 ? "SPIKE (instantaneous)" : `PERSISTENT (gate held ${persistH}h first)`} ===`);
    console.log(`${"hold".padEnd(6)}${"fee".padEnd(7)}${"trades".padStart(8)}${"win%".padStart(7)}${"mean$".padStart(9)}${"median$".padStart(9)}${"total$".padStart(10)}`);
    for (const holdDays of HOLDS) {
      for (const rtBps of ROUNDTRIP_BPS) {
        const all: Trade[] = [];
        for (const sym of SYMBOLS) all.push(...simulate(data[sym], sym, holdDays, rtBps, persistH));
        if (!all.length) { console.log(`${(holdDays+"d").padEnd(6)}${(rtBps+"bp").padEnd(7)}${"0".padStart(8)}`); continue; }
        const nets = all.map((t) => t.net).sort((a, b) => a - b);
        const wins = nets.filter((n) => n > 0).length;
        const total = nets.reduce((s, n) => s + n, 0);
        const mean = total / nets.length;
        const med = nets[Math.floor(nets.length / 2)];
        console.log(
          `${(holdDays+"d").padEnd(6)}${(rtBps+"bp").padEnd(7)}${String(all.length).padStart(8)}${((wins/all.length*100).toFixed(0)+"%").padStart(7)}${("$"+mean.toFixed(1)).padStart(9)}${("$"+med.toFixed(1)).padStart(9)}${("$"+total.toFixed(0)).padStart(10)}`,
        );
      }
    }
  }

  // best/worst trades at the 3d/20bp baseline for color
  const base: Trade[] = [];
  for (const sym of SYMBOLS) base.push(...simulate(data[sym], sym, 3, 20));
  base.sort((a, b) => b.net - a.net);
  const fmt = (t: Trade) => `${t.symbol} ${new Date(t.openTs).toISOString().slice(5,10)} hold=${(t.holdH/24).toFixed(1)}d carry=$${t.carry.toFixed(1)} net=$${t.net.toFixed(1)}`;
  console.log(`\nat 3d/20bp — best: ${base[0] ? fmt(base[0]) : "none"}`);
  console.log(`           worst: ${base.length ? fmt(base[base.length-1]) : "none"}`);
  console.log(`\nNOTE: fill cost is a fixed bps assumption (no historical depth); Paradex excluded (5s feed). Realized funding is actual, not predicted.`);
}

main();
