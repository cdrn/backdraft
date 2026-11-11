import { SpreadAlert } from "./alerts.js";
import {
  CEX_VENUES,
  CHAINS,
  DEXES,
  EPISODE_CLOSE_BPS,
  EPISODE_OPEN_BPS,
  LATENCY_MS,
  PAIRS,
  POLL_INTERVAL_MS,
  RETENTION_DAYS,
  ROLLUP_RETENTION_DAYS,
  ROUTE_KINDS,
  SIZES_USD,
} from "./config.js";
import { mid, trimLevels } from "./derive/book.js";
import { EpisodeDetector } from "./derive/episodes.js";
import { PaperLedger } from "./derive/paper.js";
import { bestPerRoute, computeCells } from "./derive/spreads.js";
import { ChainQuoter, type QuoteRequest } from "./quoters/evm.js";
import type { Store } from "./store.js";
import { buildVenues } from "./venues/index.js";
import type { Book, DexQuote } from "./types.js";

// Tick order matters: CEX books first (fast, give us the reference mid), then
// one chunked multicall per chain sized off those mids, then the board. Both
// legs of every cell are within a few hundred ms of each other at the 10s
// cadence.

export interface VenueHealth {
  name: string;
  ok: boolean;
  lastError: string | null;
  lastOkTs: number | null;
}

const REDISCOVER_MS = 60 * 60_000;
const PRUNE_MS = 60 * 60_000;
// store only the depth a clip can walk: twice the largest size, ≥20 levels
const BOOK_USD_CAP = 2 * Math.max(...SIZES_USD);

export class Collector {
  private venues = buildVenues(CEX_VENUES);
  private quoters = CHAINS.map((c) => new ChainQuoter(c, DEXES, PAIRS)).filter((q) => q.dexes.length);
  private alert = new SpreadAlert();
  private detector: EpisodeDetector;
  private paper: PaperLedger;
  readonly health = new Map<string, VenueHealth>();
  // quotes per DEX on the last tick — the dashboard's "is this DEX alive"
  readonly dexQuoteCounts = new Map<string, number>();
  private running = false;
  private startedAt = 0;
  private prunedAt = 0;

  constructor(private store: Store) {
    this.detector = new EpisodeDetector(store, EPISODE_OPEN_BPS, EPISODE_CLOSE_BPS, {
      onOpen: (ep) => void this.alert.alertOpen(ep),
      onClose: (ep, ts) => void this.alert.alertClose(ep, ts),
    });
    this.paper = new PaperLedger(store, EPISODE_OPEN_BPS, LATENCY_MS, POLL_INTERVAL_MS * 3);
    for (const v of this.venues) this.health.set(v.name, { name: v.name, ok: false, lastError: null, lastOkTs: null });
    for (const q of this.quoters) this.health.set(q.chain, { name: q.chain, ok: false, lastError: null, lastOkTs: null });
    for (const d of DEXES) this.dexQuoteCounts.set(d.id, 0);
    console.log(
      `[spread] venues: ${this.venues.map((v) => v.name).join(",")}  dexes: ${DEXES.map((d) => d.id).join(",")}  ` +
        `pairs: ${PAIRS.map((p) => p.pair).join(",")}  kinds: ${ROUTE_KINDS.join(",")}  sizes: ${SIZES_USD.join("/")}  ` +
        `poll ${POLL_INTERVAL_MS / 1000}s  latency ${LATENCY_MS / 1000}s  telegram ${this.alert.enabled ? "armed" : "off"}`,
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
        if (r.value)
          books.push({ ...r.value, bids: trimLevels(r.value.bids, BOOK_USD_CAP), asks: trimLevels(r.value.asks, BOOK_USD_CAP) });
      } else {
        failed.add(owners[i]);
        this.mark(owners[i], r.reason);
      }
    });
    for (const v of this.venues) if (!failed.has(v.name)) this.mark(v.name, null);
    return books;
  }

  // Pools are discovered lazily and refreshed hourly; a failed discovery
  // just means we keep quoting every tier until the next one succeeds.
  private async maybeDiscover(): Promise<void> {
    const due = this.quoters.filter((q) => Date.now() - q.discoveredAt > REDISCOVER_MS);
    if (!due.length) return;
    const probeSizes = [...new Set([Math.min(...SIZES_USD), Math.max(...SIZES_USD)])];
    const results = await Promise.allSettled(due.map((q) => q.discover(probeSizes)));
    results.forEach((r, i) => {
      const q = due[i];
      if (r.status === "fulfilled") console.log(`[spread] ${q.chain} pools: ${q.liveSummary() || "none"}`);
      else console.warn(`[spread] ${q.chain} discovery failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    });
  }

  private maybePrune(): void {
    if (Date.now() - this.prunedAt < PRUNE_MS) return;
    this.prunedAt = Date.now();
    const n = this.store.prune(Date.now() - RETENTION_DAYS * 86_400_000, Date.now() - ROLLUP_RETENTION_DAYS * 86_400_000);
    if (n.books || n.quotes || n.cells) console.log(`[spread] pruned >${RETENTION_DAYS}d: ${n.books} books ${n.quotes} quotes ${n.cells} cells`);
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
    for (const k of this.dexQuoteCounts.keys()) this.dexQuoteCounts.set(k, 0);
    for (const q of quotes) this.dexQuoteCounts.set(q.dex, (this.dexQuoteCounts.get(q.dex) ?? 0) + 1);
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
      await this.maybeDiscover();
      const books = await this.fetchBooks();
      const quotes = await this.fetchQuotes(books);
      const ts = Date.now();
      const cells = computeCells(books, quotes, PAIRS, SIZES_USD, ts, ROUTE_KINDS);
      this.store.insertTick(books, quotes, cells);
      this.detector.update(cells, ts);
      this.paper.update(cells, ts);
      this.maybePrune();
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
