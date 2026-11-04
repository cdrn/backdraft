import type { Store } from "../store.js";
import type { Kind } from "../types.js";

// Per-route deployment stats over a window: how often is the route positive,
// how fat is the tail, does it recur, and how long does it last. This is the
// table that answers "is there anything here at my speed".

export interface RouteStats {
  route: string;
  pair: string;
  kind: Kind;
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
  const agg = new Map(store.routeAgg(since, size).map((a) => [a.route, a]));
  const episodes = store.episodesSince(since);
  const epByRoute = new Map<string, typeof episodes>();
  for (const ep of episodes) (epByRoute.get(ep.route) ?? epByRoute.set(ep.route, []).get(ep.route)!).push(ep);

  const routes = new Set([...agg.keys(), ...epByRoute.keys()]);
  return [...routes].map((route) => {
    const a = agg.get(route);
    const eps = epByRoute.get(route) ?? [];
    const durs = eps
      .map((e) => ((e.closedTs ?? e.lastTs) - e.openedTs) / 1000)
      .sort((x, y) => x - y);
    return {
      route,
      pair: a?.pair ?? route.slice(0, route.indexOf(" ")),
      kind: a?.kind ?? ("dex→cex" as Kind),
      ticks: a?.ticks ?? 0,
      positiveShare: a?.positiveShare ?? 0,
      p50Bps: a?.p50Bps ?? null,
      p90Bps: a?.p90Bps ?? null,
      maxBps: a?.maxBps ?? null,
      currentNetBps: a?.currentNetBps ?? null,
      episodes: eps.length,
      openNow: eps.some((e) => e.closedTs === null),
      medianDurationSec: quantile(durs, 0.5),
      totalOpportunityUsd: eps.reduce((s, e) => s + e.peakUsd, 0),
    };
  });
}
