// Replay the full quote history through the episode detector. Run after
// changing thresholds or the cost model: episodes are derived data, the raw
// quotes are the source of truth. No alerts fire during backfill.
//
//   npm run delta:backfill

import "dotenv/config";
import {
  CHAIN_NAMES,
  DB_PATH,
  EPISODE_CLOSE_BPS,
  EPISODE_OPEN_BPS,
  POLL_INTERVAL_MS,
  SIZES_USD,
} from "./config.js";
import { EpisodeDetector } from "./derive/episodes.js";
import { PaperLedger } from "./derive/paper.js";
import { computeBoard } from "./derive/spreads.js";
import { Store } from "./store.js";

const store = new Store(DB_PATH);
store.clearEpisodes();
store.clearPaperEntries();
const detector = new EpisodeDetector(
  store,
  EPISODE_OPEN_BPS,
  EPISODE_CLOSE_BPS,
);
// re-derive the paper ledger under the current settle logic (bridge-time)
const paper = new PaperLedger(store, EPISODE_OPEN_BPS);

// Group quotes into ticks by poll-interval bucket.
const rows = store.allQuotesOrdered();
const buckets = new Map<number, typeof rows>();
for (const r of rows) {
  const b = Math.round(r.ts / POLL_INTERVAL_MS);
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b)!.push(r);
}

let ticks = 0;
for (const [bucket, quotes] of [...buckets.entries()].sort(
  (a, b) => a[0] - b[0],
)) {
  const board = computeBoard(quotes, CHAIN_NAMES, SIZES_USD);
  const tickTs = bucket * POLL_INTERVAL_MS;
  detector.update(board, tickTs);
  paper.update(board, tickTs);
  ticks++;
}

const ps = store.paperStats();
console.log(
  `\npaper ledger (re-derived, bridge-time settle): ${ps.settled} settled, ${ps.pending} pending` +
    `\n  hit rate ${(ps.hitRate * 100).toFixed(1)}%  mean expected ${ps.meanExpectedBps.toFixed(2)}bps` +
    `  mean realized ${ps.meanRealizedBps.toFixed(2)}bps  latency tax ${ps.meanSlippageBps.toFixed(2)}bps\n`,
);

const episodes = store.recentEpisodes(1000);
console.log(`replayed ${ticks} ticks, ${episodes.length} episodes:`);
for (const ep of episodes) {
  const dur = ((ep.closedTs ?? ep.lastTs) - ep.openedTs) / 60_000;
  console.log(
    `  ${ep.route}  ${new Date(ep.openedTs).toISOString()}  ` +
      `${dur.toFixed(0)}min  peak ${ep.peakBps.toFixed(2)}bps  ` +
      `$${ep.peakUsd.toFixed(2)}/trip @ $${ep.peakSize.toLocaleString()}` +
      (ep.closedTs ? "" : "  [OPEN]"),
  );
}
