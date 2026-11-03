import type { Store } from "../store.js";

// Per-route deployment stats over a window: how often is the route positive,
// how fat is the tail, does it recur, and how long does it last. This is the
// table that answers "is there anything here at my speed".

export interface RouteStats {
  route: string;
  ticks: number;
  positiveShare: number; // fraction of ticks with net > 0
  p50Bps: number | null;
  p90Bps: number | null;
  maxBps: number | null;
  currentNetBps: number | null;
  episodes: number;
  openNow: boolean;
  medianDurationSec: number | null;
  totalOpportunityUsd: number;
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

export function routeStats(store: Store, days: number, size: number): RouteStats[] {
  const since = Date.now() - days * 86_400_000;
  const cells = store.cellsSince(since, size);
  const byRoute = new Map<string, number[]>();
  const current = new Map<string, { ts: number; netBps: number }>();
  for (const c of cells) {
    (byRoute.get(c.route) ?? byRoute.set(c.route, []).get(c.route)!).push(c.netBps);
    const cur = current.get(c.route);
    if (!cur || c.ts > cur.ts || (c.ts === cur.ts && c.netBps > cur.netBps))
      current.set(c.route, { ts: c.ts, netBps: c.netBps });
  }
  const episodes = store.episodesSince(since);
  const epByRoute = new Map<string, typeof episodes>();
  for (const ep of episodes) (epByRoute.get(ep.route) ?? epByRoute.set(ep.route, []).get(ep.route)!).push(ep);

  const routes = new Set([...byRoute.keys(), ...epByRoute.keys()]);
  return [...routes].map((route) => {
    const nets = (byRoute.get(route) ?? []).slice().sort((a, b) => a - b);
    const eps = epByRoute.get(route) ?? [];
    const durs = eps
      .map((e) => ((e.closedTs ?? e.lastTs) - e.openedTs) / 1000)
      .sort((a, b) => a - b);
    return {
      route,
      ticks: nets.length,
      positiveShare: nets.length ? nets.filter((n) => n > 0).length / nets.length : 0,
      p50Bps: quantile(nets, 0.5),
      p90Bps: quantile(nets, 0.9),
      maxBps: nets.length ? nets[nets.length - 1] : null,
      currentNetBps: current.get(route)?.netBps ?? null,
      episodes: eps.length,
      openNow: eps.some((e) => e.closedTs === null),
      medianDurationSec: quantile(durs, 0.5),
      totalOpportunityUsd: eps.reduce((s, e) => s + e.peakUsd, 0),
    };
  });
}
