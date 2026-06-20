import { FUNDING_POLL_INTERVAL_MS, SYMBOLS } from "./config.js";
import { computeDispersion } from "./derive/dispersion.js";
import { computeImpact, type BookImpact } from "./derive/impact.js";
import { PaperLedger } from "./derive/paper.js";
import type { Store } from "./store.js";
import type { FundingSnapshot, FundingVenue } from "./types.js";
import { DydxVenue } from "./venues/dydx.js";
import { HyperliquidVenue } from "./venues/hyperliquid.js";
import { OkxVenue } from "./venues/okx.js";
import { ParadexVenue } from "./venues/paradex.js";

// Poll every venue in parallel each tick; a venue that errors drops out for
// that tick (logged) without stalling the others. Raw snapshots persist;
// the dispersion board is derived and logged.
export function startCollector(store: Store): void {
  const venues: FundingVenue[] = [
    new HyperliquidVenue(),
    new DydxVenue(),
    new OkxVenue(),
    new ParadexVenue(),
  ];
  console.log(
    `[funding] venues: ${venues.map((v) => `${v.name}(${v.intervalHours}h)`).join(", ")}  symbols: ${SYMBOLS.join(",")}`,
  );
  const paper = new PaperLedger(store);

  const pollVenue = async (v: FundingVenue): Promise<FundingSnapshot[]> => {
    try {
      return await v.poll(SYMBOLS);
    } catch (err) {
      console.error(
        `[${v.name}] poll failed: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  };

  // One L2 book fetch per venue/symbol → depth/slippage impact. Each fetch is
  // isolated; a thin or failed book just drops out (the ledger falls back to
  // flat taker fees for that leg).
  const collectImpacts = async (ts: number): Promise<BookImpact[]> => {
    const jobs: Promise<BookImpact | null>[] = [];
    for (const v of venues) {
      if (!v.fetchBook) continue;
      for (const sym of SYMBOLS) {
        jobs.push(
          v
            .fetchBook(sym)
            .then((book) => (book ? computeImpact(book, v.name, sym, ts) : null))
            .catch((err) => {
              console.error(
                `[${v.name}] book ${sym}: ${err instanceof Error ? err.message : err}`,
              );
              return null;
            }),
        );
      }
    }
    return (await Promise.all(jobs)).filter((x): x is BookImpact => x !== null);
  };

  let running = false;
  const tick = async () => {
    if (running) return; // skip if previous tick still in flight
    running = true;
    try {
      const snaps = (await Promise.all(venues.map(pollVenue))).flat();
      if (snaps.length === 0) {
        console.log("[tick] no snapshots");
        return;
      }
      const now = Date.now();
      store.insert(snaps);
      const impacts = await collectImpacts(now);
      if (impacts.length) store.insertImpacts(impacts);
      const board = computeDispersion(snaps);
      paper.update(board, snaps, impacts, now);
      const top = board
        .slice(0, 3)
        .map(
          (c) =>
            `${c.symbol} ${c.netAnnPct.toFixed(1)}% net (short ${c.shortVenue} ${c.shortAnnPct.toFixed(1)} / long ${c.longVenue} ${c.longAnnPct.toFixed(1)})`,
        )
        .join("  |  ");
      console.log(`[tick] ${snaps.length} snaps  top: ${top}`);
    } finally {
      running = false;
    }
  };

  tick();
  setInterval(tick, FUNDING_POLL_INTERVAL_MS);
}
