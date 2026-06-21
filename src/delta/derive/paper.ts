import { routeCost } from "../costs.js";
import type { Store } from "../store.js";
import type { BoardCell } from "./spreads.js";

// Paper ledger — the honest "is this real money" test, without spending any.
//
// When the board shows a route clearing a threshold at tick T, we record a
// paper entry at the price quoted then (expected profit). We then re-price the
// SAME route/size AFTER the route's real bridge/rebalance window has elapsed
// (cctp-fast ~2min, usdt0/oft ~5-10min, cex ~30min) and record what we'd
// ACTUALLY have netted — because a bridge-through trade is exposed to price
// drift for the whole transit, not just one 60s poll. The gap between expected
// and realized is the real latency tax, scaled to how long the route takes.
//
// A route's bridge time is deterministic from its costs.ts corridor, so we
// recompute it from the route string rather than storing it.

// "USDC/USDT base→ethereum" → bridge minutes for that round-trip corridor.
function bridgeMinutes(route: string): number {
  const sp = route.indexOf(" ");
  if (sp < 0) return 1;
  const [base, quote] = route.slice(0, sp).split("/");
  const [from, to] = route.slice(sp + 1).split("→");
  if (!base || !quote || !from || !to) return 1;
  return routeCost(base, quote, from, to).minutes;
}

// Stop waiting for a route to reappear this long past its bridge window — past
// this, the dislocation is gone and we settle at whatever's there (or
// unfillable). Keeps pending entries from living forever on a quote gap.
const SETTLE_GRACE_MIN = 15;

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

    // 1. settle entries whose route has had time to actually complete — i.e.
    //    the real bridge/rebalance window has elapsed since open. Re-price the
    //    same route now: does the dislocation survive the transit?
    for (const e of this.store.pendingPaperEntries()) {
      const elapsedMin = (ts - e.openedTs) / 60_000;
      const matureMin = bridgeMinutes(e.route);
      if (elapsedMin < matureMin) continue; // still mid-bridge — leave pending
      const cell = best.get(e.route);
      if (!cell && elapsedMin < matureMin + SETTLE_GRACE_MIN) continue; // gap — retry
      const realizedBps = cell ? cell.netBps : -9999; // gone past grace = unfillable
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
