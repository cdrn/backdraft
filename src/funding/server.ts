import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FUNDING_POLL_INTERVAL_MS,
  FUNDING_PORT,
  FUNDING_PUBLIC_DIR,
  SYMBOLS,
} from "./config.js";
import { computeDispersion } from "./derive/dispersion.js";
import type { Store } from "./store.js";

const VENUE_META = [
  { name: "hyperliquid", intervalHours: 1 },
  { name: "dydx", intervalHours: 1 },
  { name: "okx", intervalHours: 8 },
];

function json(res: import("node:http").ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startServer(store: Store): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${FUNDING_PORT}`);

    // Latest snapshot per (venue, symbol) — the raw funding matrix.
    if (url.pathname === "/api/latest") return json(res, store.latest());

    // Dispersion board: best cross-venue carry pair per symbol, net of fees.
    if (url.pathname === "/api/board")
      return json(res, computeDispersion(store.latest()));

    // Raw snapshot history for charting annualized funding per venue/symbol.
    if (url.pathname === "/api/series") {
      const minutes = Number(url.searchParams.get("minutes") ?? 360);
      return json(res, store.series(minutes));
    }

    // Carry paper ledger — open positions (live carry) + recent closed + stats.
    if (url.pathname === "/api/paper") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json(res, {
        stats: store.paperStats(),
        open: store.openPaperPositions(),
        closed: store.recentClosedPaperPositions(limit),
      });
    }

    if (url.pathname === "/api/status") {
      return json(res, {
        pollIntervalMs: FUNDING_POLL_INTERVAL_MS,
        venues: VENUE_META,
        symbols: SYMBOLS,
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = readFileSync(join(FUNDING_PUBLIC_DIR, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end(`missing ${FUNDING_PUBLIC_DIR}/index.html`);
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(FUNDING_PORT, () => {
    console.log(`[funding:server] http://localhost:${FUNDING_PORT}`);
  });
}
