import { SpreadAlert } from "./alerts.js";
import {
  CEX_VENUES,
  CHAINS,
  EPISODE_CLOSE_BPS,
  EPISODE_OPEN_BPS,
  LATENCY_MS,
  PAIRS,
  POLL_INTERVAL_MS,
  SIZES_USD,
} from "./config.js";
import { mid } from "./derive/book.js";
import { EpisodeDetector } from "./derive/episodes.js";
import { PaperLedger } from "./derive/paper.js";
import { bestPerRoute, computeCells } from "./derive/spreads.js";
import { UniV3Quoter, type QuoteRequest } from "./quoters/univ3.js";
import type { Store } from "./store.js";
import { buildVenues } from "./venues/index.js";
import type { Book, DexQuote } from "./types.js";

// Tick order matters: CEX books first (fast, give us the reference mid), then
// one multicall per chain sized off those mids, then the board. Both legs of
// every cell are within a few hundred ms of each other at the 10s cadence.

export interface VenueHealth {
  name: string;
  ok: boolean;
  lastError: string | null;
  lastOkTs: number | null;
}

export class Collector {
  private venues = buildVenues(CEX_VENUES);
  private quoters = CHAINS.map((c) => new UniV3Quoter(c, PAIRS));
  private alert = new SpreadAlert();
  private detector: EpisodeDetector;
  private paper: PaperLedger;
  readonly health = new Map<string, VenueHealth>();
  private running = false;
  private startedAt = 0;

  constructor(private store: Store) {
    this.detector = new EpisodeDetector(store, EPISODE_OPEN_BPS, EPISODE_CLOSE_BPS, {
      onOpen: (ep) => void this.alert.alertOpen(ep),
      onClose: (ep, ts) => void this.alert.alertClose(ep, ts),
    });
    this.paper = new PaperLedger(store, EPISODE_OPEN_BPS, LATENCY_MS, POLL_INTERVAL_MS * 3);
    for (const v of this.venues) this.health.set(v.name, { name: v.name, ok: false, lastError: null, lastOkTs: null });
    for (const q of this.quoters) this.health.set(q.chain, { name: q.chain, ok: false, lastError: null, lastOkTs: null });
    console.log(
      `[spread] venues: ${this.venues.map((v) => v.name).join(",")}  chains: ${CHAINS.map((c) => c.name).join(",")}  ` +
        `sizes: ${SIZES_USD.join("/")}  poll ${POLL_INTERVAL_MS / 1000}s  latency ${LATENCY_MS / 1000}s  telegram ${this.alert.enabled ? "armed" : "off"}`,
    );
  }

  private mark(name: string, err: unknown): void {
    const h = this.health.get(name)!;
    if (err) {
      h.ok = false;
      h.lastError = err instanceof Error ? err.message : String(err);
    } else {
      h.ok = true;
      h.lastError = null;
      h.lastOkTs = Date.now();
    }
  }

  private async fetchBooks(): Promise<Book[]> {
    const jobs: Promise<Book | null>[] = [];
    const owners: string[] = [];
    for (const v of this.venues) {
      for (const p of PAIRS) {
        const sym = p.cex[v.name];
        if (!sym) continue;
        jobs.push(v.fetchBook(sym));
        owners.push(v.name);
      }
    }
    const settled = await Promise.allSettled(jobs);
    const books: Book[] = [];
    const failed = new Set<string>();
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        if (r.value) books.push(r.value);
      } else {
        failed.add(owners[i]);
        this.mark(owners[i], r.reason);
      }
    });
    for (const v of this.venues) if (!failed.has(v.name)) this.mark(v.name, null);
    return books;
  }

  private async fetchQuotes(books: Book[]): Promise<DexQuote[]> {
    // reference mid per pair = mean of venue mids
    const refMid = new Map<string, number>();
    for (const p of PAIRS) {
      const mids = books
        .filter((b) => p.cex[b.venue] === b.symbol)
        .map((b) => mid(b.bids, b.asks))
        .filter((m): m is number => m !== null);
      if (mids.length) refMid.set(p.pair, mids.reduce((s, x) => s + x, 0) / mids.length);
    }
    const reqs: QuoteRequest[] = [];
    for (const p of PAIRS) {
      const m = refMid.get(p.pair);
      if (!m) continue;
      for (const size of SIZES_USD) {
        reqs.push({ pair: p.pair, dir: "buy", amountIn: size });
        reqs.push({ pair: p.pair, dir: "sell", amountIn: size / m });
      }
    }
    const results = await Promise.allSettled(
      this.quoters.map((q) => q.quoteMany(reqs.filter((r) => q.supports(r.pair)))),
    );
    const quotes: DexQuote[] = [];
    results.forEach((r, i) => {
      const name = this.quoters[i].chain;
      if (r.status === "fulfilled") {
        quotes.push(...r.value);
        this.mark(name, r.value.length ? null : new Error("no quotes returned"));
      } else this.mark(name, r.reason);
    });
    return quotes;
  }

  async tick(): Promise<void> {
    const STALL_MS = POLL_INTERVAL_MS * 3;
    if (this.running) {
      if (Date.now() - this.startedAt < STALL_MS) return;
      console.warn(`[spread] tick stalled ${Math.round((Date.now() - this.startedAt) / 1000)}s — forcing reset`);
    }
    this.running = true;
    this.startedAt = Date.now();
    try {
      const books = await this.fetchBooks();
      const quotes = await this.fetchQuotes(books);
      const ts = Date.now();
      const cells = computeCells(books, quotes, PAIRS, SIZES_USD, ts);
      this.store.insertTick(books, quotes, cells);
      this.detector.update(cells, ts);
      this.paper.update(cells, ts);
      const best = [...bestPerRoute(cells).values()].sort((a, b) => b.netBps - a.netBps);
      const top = best.slice(0, 3).map((c) => `${c.route} ${c.netBps >= 0 ? "+" : ""}${c.netBps.toFixed(1)}`).join("  ");
      console.log(`[spread] ${books.length} books  ${quotes.length} quotes  ${cells.length} cells  best: ${top || "—"}`);
    } catch (err) {
      console.error(`[spread] tick failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }

  start(): void {
    void this.tick();
    setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }
}

export function startCollector(store: Store): Collector {
  const c = new Collector(store);
  c.start();
  return c;
}
