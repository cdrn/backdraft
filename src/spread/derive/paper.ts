import { bestPerRoute } from "./spreads.js";
import type { Store } from "../store.js";
import type { Cell } from "../types.js";

// Paper ledger — the latency-tax instrument.
//
// When a route's best net clears the entry threshold at tick T we record
// what the quote promised. At the first tick ≥ T + LATENCY_MS we re-price
// the same route and size and record what we'd actually have netted landing
// that late. The gap, averaged, is the latency tax at this operator's speed.
// A route that has no cell by T + LATENCY_MS + grace settles as UNFILLABLE
// (realized null) rather than as a fake number.
//
// One in-flight position per route: a standing basis is one dislocation, not
// a new one every tick.

export interface PaperEntry {
  id: number;
  openedTs: number;
  route: string;
  size: number;
  expectedNetBps: number;
  expectedUsd: number;
  settledTs: number | null;
  realizedNetBps: number | null;
  realizedUsd: number | null;
}

export interface PaperStats {
  settled: number;
  filled: number;
  unfillable: number;
  pending: number;
  meanExpectedBps: number;
  meanRealizedBps: number;
  latencyTaxBps: number;
  hitRate: number; // fraction of filled entries still net-positive
  realizedUsdTotal: number;
}

export class PaperLedger {
  constructor(
    private store: Store,
    private entryThresholdBps: number,
    private latencyMs: number,
    private graceMs: number,
  ) {}

  update(cells: Cell[], ts: number): void {
    const best = bestPerRoute(cells);
    const occupied = new Set<string>();

    for (const e of this.store.pendingPaperEntries()) {
      const elapsed = ts - e.openedTs;
      if (elapsed < this.latencyMs) {
        occupied.add(e.route);
        continue;
      }
      const cell = cells.find((c) => c.route === e.route && c.size === e.size);
      if (!cell) {
        if (elapsed < this.latencyMs + this.graceMs) {
          occupied.add(e.route);
          continue;
        }
        this.store.settlePaperEntry(e.id, ts, null, null);
        continue;
      }
      this.store.settlePaperEntry(e.id, ts, cell.netBps, cell.netUsd);
    }

    // open: best-dollar cell per route above threshold, if route is free
    const open = new Map<string, Cell>();
    for (const c of cells) {
      if (c.netBps < this.entryThresholdBps || occupied.has(c.route)) continue;
      const b = best.get(c.route);
      if (!b || b.netBps < this.entryThresholdBps) continue;
      const prev = open.get(c.route);
      if (!prev || c.netUsd > prev.netUsd) open.set(c.route, c);
    }
    for (const [route, c] of open) {
      this.store.openPaperEntry({
        openedTs: ts,
        route,
        size: c.size,
        expectedNetBps: c.netBps,
        expectedUsd: c.netUsd,
      });
    }
  }
}
