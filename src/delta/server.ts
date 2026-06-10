import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeltaAlert } from "./alerts.js";
import {
  CHAIN_NAMES,
  POLL_INTERVAL_MS,
  PORT,
  PUBLIC_DIR,
  SIZES_USD,
} from "./config.js";
import { computeBoard, type LatestQuote } from "./derive/spreads.js";
import type { Store } from "./store.js";

function json(res: import("node:http").ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Net spread per route over time, recomputed from raw quotes tick by tick.
function routeSeries(
  store: Store,
  minutes: number,
  size: number,
): Record<string, { ts: number; netBps: number }[]> {
  const rows = store.quotesSince(Date.now() - minutes * 60_000);
  const buckets = new Map<number, LatestQuote[]>();
  for (const r of rows) {
    const b = Math.round(r.ts / POLL_INTERVAL_MS);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(r);
  }
  const out: Record<string, { ts: number; netBps: number }[]> = {};
  for (const [bucket, quotes] of [...buckets.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const cells = computeBoard(quotes, CHAIN_NAMES, [size]);
    const bestPerRoute = new Map<string, number>();
    for (const c of cells) {
      const route = `${c.from}→${c.to}`;
      const prev = bestPerRoute.get(route);
      if (prev === undefined || c.netBps > prev)
        bestPerRoute.set(route, c.netBps);
    }
    for (const [route, netBps] of bestPerRoute) {
      if (!out[route]) out[route] = [];
      out[route].push({ ts: bucket * POLL_INTERVAL_MS, netBps });
    }
  }
  return out;
}

// Per-route deployment stats: how often does this route pay, for how long,
// and how much — the "where do I park inventory" view.
function routeStats(store: Store, days: number): unknown[] {
  const episodes = store.episodesSince(Date.now() - days * 86_400_000);
  const board = computeBoard(
    store.latest() as LatestQuote[],
    CHAIN_NAMES,
    SIZES_USD,
  );
  const currentNet = new Map<string, number>();
  for (const c of board) {
    const route = `${c.from}→${c.to}`;
    const prev = currentNet.get(route);
    if (prev === undefined || c.netBps > prev) currentNet.set(route, c.netBps);
  }

  const byRoute = new Map<string, typeof episodes>();
  for (const ep of episodes) {
    if (!byRoute.has(ep.route)) byRoute.set(ep.route, []);
    byRoute.get(ep.route)!.push(ep);
  }

  const routes = new Set([...currentNet.keys(), ...byRoute.keys()]);
  return [...routes].map((route) => {
    const eps = byRoute.get(route) ?? [];
    const durations = eps
      .map((e) => ((e.closedTs ?? e.lastTs) - e.openedTs) / 60_000)
      .sort((a, b) => a - b);
    const median = durations.length
      ? durations[Math.floor(durations.length / 2)]
      : null;
    return {
      route,
      currentNetBps: currentNet.get(route) ?? null,
      episodes: eps.length,
      openNow: eps.some((e) => e.closedTs === null),
      medianDurationMin: median,
      totalOpportunityUsd: eps.reduce((s, e) => s + e.peakUsd, 0),
      maxPeakBps: eps.length ? Math.max(...eps.map((e) => e.peakBps)) : null,
      lastOpenedTs: eps.length ? eps[eps.length - 1].openedTs : null,
    };
  });
}

export function startServer(store: Store): void {
  const alert = new DeltaAlert();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/api/series") {
      const minutes = Number(url.searchParams.get("minutes") ?? 60);
      const size = Number(url.searchParams.get("size") ?? 100_000);
      return json(res, store.series(minutes, size));
    }

    if (url.pathname === "/api/latest") return json(res, store.latest());

    if (url.pathname === "/api/board") {
      return json(
        res,
        computeBoard(store.latest() as LatestQuote[], CHAIN_NAMES, SIZES_USD),
      );
    }

    if (url.pathname === "/api/episodes") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json(res, store.recentEpisodes(limit));
    }

    if (url.pathname === "/api/route-series") {
      const minutes = Number(url.searchParams.get("minutes") ?? 60);
      const size = Number(url.searchParams.get("size") ?? 100_000);
      return json(res, routeSeries(store, minutes, size));
    }

    if (url.pathname === "/api/route-stats") {
      const days = Number(url.searchParams.get("days") ?? 7);
      return json(res, routeStats(store, days));
    }

    if (url.pathname === "/api/status") {
      return json(res, {
        telegram: alert.enabled,
        openEpisodes: store.openEpisodes().length,
        pollIntervalMs: POLL_INTERVAL_MS,
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = readFileSync(join(PUBLIC_DIR, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end(`missing ${PUBLIC_DIR}/index.html`);
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(PORT, () => {
    console.log(`[delta:server] http://localhost:${PORT}`);
  });
}
