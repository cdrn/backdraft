import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Collector } from "./collector.js";
import {
  CEX_EXEC,
  CEX_VENUES,
  CHAIN_NAMES,
  EPISODE_OPEN_BPS,
  LATENCY_MS,
  POLL_INTERVAL_MS,
  PORT,
  PUBLIC_DIR,
  SIZES_USD,
} from "./config.js";
import { cexFeeBps } from "./costs.js";
import { routeStats } from "./derive/stats.js";
import type { Store } from "./store.js";

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startServer(store: Store, collector?: Collector): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const num = (k: string, d: number) => Number(url.searchParams.get(k) ?? d);

    if (url.pathname === "/api/board") return json(res, store.latestCells());

    if (url.pathname === "/api/series")
      return json(res, store.routeSeries(num("minutes", 60), num("size", SIZES_USD[0])));

    if (url.pathname === "/api/stats")
      return json(res, routeStats(store, num("days", 7), num("size", SIZES_USD[0])));

    if (url.pathname === "/api/episodes") return json(res, store.recentEpisodes(num("limit", 50)));

    if (url.pathname === "/api/paper")
      return json(res, {
        stats: store.paperStats(Date.now() - num("days", 7) * 86_400_000),
        entries: store.recentPaperEntries(num("limit", 50)),
      });

    if (url.pathname === "/api/status")
      return json(res, {
        pollIntervalMs: POLL_INTERVAL_MS,
        latencyMs: LATENCY_MS,
        sizes: SIZES_USD,
        chains: CHAIN_NAMES,
        cex: CEX_VENUES.map((v) => ({ name: v, feeBps: cexFeeBps(v) })),
        exec: CEX_EXEC,
        openBps: EPISODE_OPEN_BPS,
        openEpisodes: store.openEpisodes().length,
        ticks24h: store.tickCount(Date.now() - 86_400_000),
        health: collector ? [...collector.health.values()] : [],
      });

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(readFileSync(join(PUBLIC_DIR, "index.html")));
      } catch {
        res.writeHead(500);
        res.end(`missing ${PUBLIC_DIR}/index.html`);
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
  server.listen(PORT, () => console.log(`[spread:server] http://localhost:${PORT}`));
}
