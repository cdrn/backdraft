import type { Store } from "../store.js";
import type { BoardCell } from "./spreads.js";

// Paper ledger — the honest "is this real money" test, without spending any.
//
// When the board shows a route clearing a threshold at tick T, we record a
// paper entry at the price quoted then (expected profit). One tick later we
// re-price the SAME route/size with fresh quotes and record what we'd
// ACTUALLY have netted if we'd acted on the T-quote (realized profit). The
// gap is the latency/slippage tax — the difference between a spread you see
// and a spread you can capture on a 30s poll.

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
  pending: number;
  meanExpectedBps: number;
  meanRealizedBps: number;
  meanSlippageBps: number;
  hitRate: number; // fraction still net-positive after latency
  realizedUsdTotal: number;
}

export class PaperLedger {
  constructor(
    private store: Store,
    private entryThresholdBps: number,
  ) {}

  // Best cell per route at a given tick's board.
  private bestPerRoute(cells: BoardCell[]): Map<string, BoardCell> {
    const best = new Map<string, BoardCell>();
    for (const c of cells) {
      const route = `${c.pair} ${c.from}→${c.to}`;
      const prev = best.get(route);
      if (!prev || c.netBps > prev.netBps) best.set(route, c);
    }
    return best;
  }

  update(cells: BoardCell[], ts: number): void {
    const best = this.bestPerRoute(cells);

    // 1. settle entries opened on prior ticks against current prices
    for (const e of this.store.pendingPaperEntries()) {
      const cell = best.get(e.route);
      const realizedBps = cell ? cell.netBps : -9999; // route vanished = unfillable
      this.store.settlePaperEntry(
        e.id,
        ts,
        realizedBps,
        (realizedBps / 10_000) * e.size,
      );
    }

    // 2. open new entries for routes currently above the entry threshold,
    //    at the size with the best net dollars
    const bySize = new Map<string, BoardCell>();
    for (const c of cells) {
      if (c.netBps < this.entryThresholdBps) continue;
      const route = `${c.pair} ${c.from}→${c.to}`;
      const prev = bySize.get(route);
      if (!prev || c.netUsd > prev.netUsd) bySize.set(route, c);
    }
    for (const [route, c] of bySize) {
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
