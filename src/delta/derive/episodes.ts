import type { Store } from "../store.js";
import type { BoardCell } from "./spreads.js";

// Episode detection: a route "opens" when its best net spread crosses the
// open threshold and closes when it falls back under the close threshold
// (hysteresis so flicker doesn't spam the catalog). State lives in the DB —
// open episodes have closed_ts NULL — so restarts and backfills work.

export interface Episode {
  id: number;
  route: string;
  openedTs: number;
  closedTs: number | null;
  peakBps: number;
  peakSize: number;
  peakUsd: number;
  lastTs: number;
}

export interface EpisodeHandlers {
  onOpen?: (ep: Episode) => void;
  onClose?: (ep: Episode, ts: number) => void;
}

export class EpisodeDetector {
  private open = new Map<string, Episode>();

  constructor(
    private store: Store,
    private openBps: number,
    private closeBps: number,
    private handlers: EpisodeHandlers = {},
  ) {
    for (const ep of store.openEpisodes()) this.open.set(ep.route, ep);
  }

  update(cells: BoardCell[], ts: number): void {
    // state machine runs on the best net bps per route; peak dollars are
    // tracked from the best positive-net dollar cell, which may be a
    // different (larger) size
    const bestBps = new Map<string, BoardCell>();
    const bestUsd = new Map<string, BoardCell>();
    for (const c of cells) {
      const route = `${c.from}→${c.to}`;
      const b = bestBps.get(route);
      if (!b || c.netBps > b.netBps) bestBps.set(route, c);
      if (c.netBps > 0) {
        const u = bestUsd.get(route);
        if (!u || c.netUsd > u.netUsd) bestUsd.set(route, c);
      }
    }

    for (const [route, cell] of bestBps) {
      const ep = this.open.get(route);
      const usd = bestUsd.get(route);
      if (ep) {
        if (cell.netBps < this.closeBps) {
          this.store.closeEpisode(ep.id, ts);
          this.open.delete(route);
          this.handlers.onClose?.(ep, ts);
        } else if (usd && usd.netUsd > ep.peakUsd) {
          ep.peakBps = Math.max(ep.peakBps, cell.netBps);
          ep.peakSize = usd.size;
          ep.peakUsd = usd.netUsd;
          ep.lastTs = ts;
          this.store.updateEpisodePeak(ep);
        } else {
          ep.lastTs = ts;
          this.store.touchEpisode(ep.id, ts);
        }
      } else if (cell.netBps >= this.openBps) {
        const created = this.store.openEpisode({
          route,
          openedTs: ts,
          peakBps: cell.netBps,
          peakSize: usd?.size ?? cell.size,
          peakUsd: usd?.netUsd ?? cell.netUsd,
          lastTs: ts,
        });
        this.open.set(route, created);
        this.handlers.onOpen?.(created);
      }
    }
  }
}
