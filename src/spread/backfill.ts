// Rebuild cells, episodes and the paper ledger from the raw books + DEX
// quotes. Run after changing fee tiers, gas, sizes, thresholds or latency —
// the raw tables are the source of truth, everything else is derived.
//
//   npm run spread:backfill

import "dotenv/config";
import {
  DB_PATH,
  EPISODE_CLOSE_BPS,
  EPISODE_OPEN_BPS,
  LATENCY_MS,
  PAIRS,
  POLL_INTERVAL_MS,
  ROUTE_KINDS,
  SIZES_USD,
} from "./config.js";
import { EpisodeDetector } from "./derive/episodes.js";
import { PaperLedger } from "./derive/paper.js";
import { computeCells } from "./derive/spreads.js";
import { Store } from "./store.js";

const store = new Store(DB_PATH);
store.clearCells();
store.clearEpisodes();
store.clearPaperEntries();
const detector = new EpisodeDetector(store, EPISODE_OPEN_BPS, EPISODE_CLOSE_BPS);
const paper = new PaperLedger(store, EPISODE_OPEN_BPS, LATENCY_MS, POLL_INTERVAL_MS * 3);

const { books, quotes } = store.rawSince(0);
const bucket = (ts: number) => Math.round(ts / POLL_INTERVAL_MS);
const ticks = new Map<number, { books: typeof books; quotes: typeof quotes }>();
for (const b of books) (ticks.get(bucket(b.ts)) ?? ticks.set(bucket(b.ts), { books: [], quotes: [] }).get(bucket(b.ts))!).books.push(b);
for (const q of quotes) (ticks.get(bucket(q.ts)) ?? ticks.set(bucket(q.ts), { books: [], quotes: [] }).get(bucket(q.ts))!).quotes.push(q);

let n = 0;
for (const [b, t] of [...ticks.entries()].sort((x, y) => x[0] - y[0])) {
  const ts = b * POLL_INTERVAL_MS;
  const cells = computeCells(t.books, t.quotes, PAIRS, SIZES_USD, ts, ROUTE_KINDS);
  store.insertCells(cells);
  detector.update(cells, ts);
  paper.update(cells, ts);
  n++;
}

const ps = store.paperStats();
console.log(
  `replayed ${n} ticks\npaper: ${ps.settled} settled (${ps.unfillable} unfillable), hit ${(ps.hitRate * 100).toFixed(1)}%, ` +
    `expected ${ps.meanExpectedBps.toFixed(2)} → realized ${ps.meanRealizedBps.toFixed(2)} bps, latency tax ${ps.latencyTaxBps.toFixed(2)} bps`,
);
for (const ep of store.recentEpisodes(200)) {
  const sec = ((ep.closedTs ?? ep.lastTs) - ep.openedTs) / 1000;
  console.log(
    `  ${ep.route}  ${new Date(ep.openedTs).toISOString()}  ${sec.toFixed(0)}s  peak ${ep.peakBps.toFixed(1)}bps  $${ep.peakUsd.toFixed(2)} @ $${ep.peakSize.toLocaleString()}${ep.closedTs ? "" : "  [OPEN]"}`,
  );
}
