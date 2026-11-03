import type { Store } from "../store.js";
import type { Cell } from "../types.js";

// A route "opens" when its best net clears the open threshold and closes
// when it drops under the close threshold (hysteresis). State is in the DB
// (closed_ts NULL = open) so restarts and backfills work.

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

  update(cells: Cell[], ts: number): void {
    const bestBps = new Map<string, Cell>();
    const bestUsd = new Map<string, Cell>();
    for (const c of cells) {
      const b = bestBps.get(c.route);
      if (!b || c.netBps > b.netBps) bestBps.set(c.route, c);
      if (c.netBps > 0) {
        const u = bestUsd.get(c.route);
        if (!u || c.netUsd > u.netUsd) bestUsd.set(c.route, c);
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

    // Routes that vanished entirely this tick (no cell at all) stay open
    // until a cell shows them under the close threshold or the grace below.
    for (const [route, ep] of this.open) {
      if (bestBps.has(route)) continue;
      if (ts - ep.lastTs > this.graceMs) {
        this.store.closeEpisode(ep.id, ts);
        this.open.delete(route);
        this.handlers.onClose?.(ep, ts);
      }
    }
  }

  graceMs = 60_000;
}
