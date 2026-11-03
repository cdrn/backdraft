import Database from "better-sqlite3";
import type { Episode } from "./derive/episodes.js";
import type { PaperEntry, PaperStats } from "./derive/paper.js";
import type { Book, Cell, DexQuote } from "./types.js";

// Raw books + raw DEX quotes are the source of truth; cells, episodes and
// paper entries are derived and can be rebuilt (npm run spread:backfill).

export class Store {
  private db: Database.Database;
  private insBook: Database.Statement;
  private insQuote: Database.Statement;
  private insCell: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        venue TEXT NOT NULL,
        symbol TEXT NOT NULL,
        bids TEXT NOT NULL,
        asks TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_books_ts ON books(ts);
      CREATE TABLE IF NOT EXISTS dex_quotes (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        chain TEXT NOT NULL,
        dex TEXT NOT NULL DEFAULT '',
        pair TEXT NOT NULL,
        dir TEXT NOT NULL,
        amount_in REAL NOT NULL,
        amount_out REAL NOT NULL,
        fee_tier INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dex_quotes_ts ON dex_quotes(ts);
    `);
    this.migrate();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cells (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        pair TEXT NOT NULL,
        kind TEXT NOT NULL,
        buy TEXT NOT NULL,
        sell TEXT NOT NULL,
        route TEXT NOT NULL,
        size REAL NOT NULL,
        buy_px REAL NOT NULL,
        sell_px REAL NOT NULL,
        gross_bps REAL NOT NULL,
        fee_bps REAL NOT NULL,
        gas_bps REAL NOT NULL,
        rebal_bps REAL NOT NULL,
        cost_bps REAL NOT NULL,
        net_bps REAL NOT NULL,
        net_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cells_ts ON cells(ts);
      CREATE INDEX IF NOT EXISTS idx_cells_route_size_ts ON cells(route, size, ts);
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY,
        route TEXT NOT NULL,
        opened_ts INTEGER NOT NULL,
        closed_ts INTEGER,
        peak_bps REAL NOT NULL,
        peak_size REAL NOT NULL,
        peak_usd REAL NOT NULL,
        last_ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_opened ON episodes(opened_ts);
      CREATE TABLE IF NOT EXISTS paper_entries (
        id INTEGER PRIMARY KEY,
        opened_ts INTEGER NOT NULL,
        route TEXT NOT NULL,
        size REAL NOT NULL,
        expected_net_bps REAL NOT NULL,
        expected_usd REAL NOT NULL,
        settled_ts INTEGER,
        realized_net_bps REAL,
        realized_usd REAL
      );
      CREATE INDEX IF NOT EXISTS idx_paper_settled ON paper_entries(settled_ts);
    `);
    this.insBook = this.db.prepare(
      `INSERT INTO books (ts, venue, symbol, bids, asks) VALUES (?, ?, ?, ?, ?)`,
    );
    this.insQuote = this.db.prepare(
      `INSERT INTO dex_quotes (ts, chain, dex, pair, dir, amount_in, amount_out, fee_tier)
       VALUES (@ts, @chain, @dex, @pair, @dir, @amountIn, @amountOut, @feeTier)`,
    );
    this.insCell = this.db.prepare(
      `INSERT INTO cells (ts, pair, kind, buy, sell, route, size, buy_px, sell_px,
         gross_bps, fee_bps, gas_bps, rebal_bps, cost_bps, net_bps, net_usd)
       VALUES (@ts, @pair, @kind, @buy, @sell, @route, @size, @buyPx, @sellPx,
         @grossBps, @feeBps, @gasBps, @rebalBps, @costBps, @netBps, @netUsd)`,
    );
  }

  // Schema v1 (2026-11-02) had chain/cex/dir cells and no `dex` on quotes.
  // Raw tables are the source of truth, so: add the column, tag old quotes
  // as Uniswap (the only DEX v1 quoted), and drop every derived table —
  // routes are keyed differently now. `npm run spread:backfill` rebuilds.
  private migrate(): void {
    const cols = (t: string) =>
      (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols("dex_quotes").includes("dex")) {
      this.db.exec(`ALTER TABLE dex_quotes ADD COLUMN dex TEXT NOT NULL DEFAULT ''`);
    }
    this.db.exec(`UPDATE dex_quotes SET dex = chain || '/uni' WHERE dex = ''`);
    const cellCols = cols("cells");
    if (cellCols.length && !cellCols.includes("kind")) {
      console.warn("[spread:store] v1 cells schema found — dropping derived tables; run spread:backfill");
      this.db.exec(`DROP TABLE cells; DROP TABLE IF EXISTS episodes; DROP TABLE IF EXISTS paper_entries;`);
    }
  }

  insertTick(books: Book[], quotes: DexQuote[], cells: Cell[]): void {
    this.db.transaction(() => {
      for (const b of books)
        this.insBook.run(b.ts, b.venue, b.symbol, JSON.stringify(b.bids), JSON.stringify(b.asks));
      for (const q of quotes) this.insQuote.run(q);
      for (const c of cells) this.insCell.run(c);
    })();
  }

  insertCells(cells: Cell[]): void {
    this.db.transaction(() => {
      for (const c of cells) this.insCell.run(c);
    })();
  }

  clearCells(): void {
    this.db.exec(`DELETE FROM cells`);
  }

  // ---- raw replay ----

  rawSince(ts: number): { books: Book[]; quotes: DexQuote[] } {
    const books = (
      this.db
        .prepare(`SELECT ts, venue, symbol, bids, asks FROM books WHERE ts >= ? ORDER BY ts`)
        .all(ts) as { ts: number; venue: string; symbol: string; bids: string; asks: string }[]
    ).map((r) => ({
      ts: r.ts,
      venue: r.venue,
      symbol: r.symbol,
      bids: JSON.parse(r.bids),
      asks: JSON.parse(r.asks),
    }));
    const quotes = this.db
      .prepare(
        `SELECT ts, chain, dex, pair, dir, amount_in AS amountIn, amount_out AS amountOut, fee_tier AS feeTier
         FROM dex_quotes WHERE ts >= ? ORDER BY ts`,
      )
      .all(ts) as DexQuote[];
    return { books, quotes };
  }

  // ---- cells ----

  private rowToCell(r: Record<string, unknown>): Cell {
    return {
      ts: r.ts as number,
      pair: r.pair as string,
      kind: r.kind as Cell["kind"],
      buy: r.buy as string,
      sell: r.sell as string,
      route: r.route as string,
      size: r.size as number,
      buyPx: r.buy_px as number,
      sellPx: r.sell_px as number,
      grossBps: r.gross_bps as number,
      feeBps: r.fee_bps as number,
      gasBps: r.gas_bps as number,
      rebalBps: r.rebal_bps as number,
      costBps: r.cost_bps as number,
      netBps: r.net_bps as number,
      netUsd: r.net_usd as number,
    };
  }

  latestCells(): Cell[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM cells c
         JOIN (SELECT route, size, MAX(ts) AS max_ts FROM cells GROUP BY route, size) m
           ON c.route = m.route AND c.size = m.size AND c.ts = m.max_ts`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToCell(r));
  }

  cellsSince(ts: number, size?: number): Cell[] {
    const rows = (
      size === undefined
        ? this.db.prepare(`SELECT * FROM cells WHERE ts >= ? ORDER BY ts`).all(ts)
        : this.db
            .prepare(`SELECT * FROM cells WHERE ts >= ? AND size = ? ORDER BY ts`)
            .all(ts, size)
    ) as Record<string, unknown>[];
    return rows.map((r) => this.rowToCell(r));
  }

  // Per-route net series at one size: best net per tick.
  routeSeries(minutes: number, size: number): Record<string, { ts: number; netBps: number }[]> {
    const rows = this.db
      .prepare(
        `SELECT route, ts, MAX(net_bps) AS netBps FROM cells
         WHERE ts >= ? AND size = ? GROUP BY route, ts ORDER BY ts`,
      )
      .all(Date.now() - minutes * 60_000, size) as { route: string; ts: number; netBps: number }[];
    const out: Record<string, { ts: number; netBps: number }[]> = {};
    for (const r of rows) (out[r.route] ??= []).push({ ts: r.ts, netBps: r.netBps });
    return out;
  }

  tickCount(sinceTs: number): number {
    return (
      this.db.prepare(`SELECT COUNT(DISTINCT ts) c FROM cells WHERE ts >= ?`).get(sinceTs) as {
        c: number;
      }
    ).c;
  }

  // ---- episodes ----

  private rowToEpisode(r: Record<string, unknown>): Episode {
    return {
      id: r.id as number,
      route: r.route as string,
      openedTs: r.opened_ts as number,
      closedTs: r.closed_ts as number | null,
      peakBps: r.peak_bps as number,
      peakSize: r.peak_size as number,
      peakUsd: r.peak_usd as number,
      lastTs: r.last_ts as number,
    };
  }

  openEpisodes(): Episode[] {
    return (
      this.db.prepare(`SELECT * FROM episodes WHERE closed_ts IS NULL`).all() as Record<
        string,
        unknown
      >[]
    ).map((r) => this.rowToEpisode(r));
  }

  recentEpisodes(limit: number): Episode[] {
    return (
      this.db
        .prepare(`SELECT * FROM episodes ORDER BY opened_ts DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[]
    ).map((r) => this.rowToEpisode(r));
  }

  episodesSince(ts: number): Episode[] {
    return (
      this.db
        .prepare(`SELECT * FROM episodes WHERE opened_ts >= ? ORDER BY opened_ts ASC`)
        .all(ts) as Record<string, unknown>[]
    ).map((r) => this.rowToEpisode(r));
  }

  openEpisode(ep: Omit<Episode, "id" | "closedTs">): Episode {
    const info = this.db
      .prepare(
        `INSERT INTO episodes (route, opened_ts, peak_bps, peak_size, peak_usd, last_ts)
         VALUES (@route, @openedTs, @peakBps, @peakSize, @peakUsd, @lastTs)`,
      )
      .run(ep as never);
    return { ...ep, id: Number(info.lastInsertRowid), closedTs: null };
  }

  updateEpisodePeak(ep: Episode): void {
    this.db
      .prepare(`UPDATE episodes SET peak_bps = ?, peak_size = ?, peak_usd = ?, last_ts = ? WHERE id = ?`)
      .run(ep.peakBps, ep.peakSize, ep.peakUsd, ep.lastTs, ep.id);
  }

  touchEpisode(id: number, ts: number): void {
    this.db.prepare(`UPDATE episodes SET last_ts = ? WHERE id = ?`).run(ts, id);
  }

  closeEpisode(id: number, ts: number): void {
    this.db.prepare(`UPDATE episodes SET closed_ts = ? WHERE id = ?`).run(ts, id);
  }

  clearEpisodes(): void {
    this.db.exec(`DELETE FROM episodes`);
  }

  // ---- paper ledger ----

  private rowToPaper(r: Record<string, unknown>): PaperEntry {
    return {
      id: r.id as number,
      openedTs: r.opened_ts as number,
      route: r.route as string,
      size: r.size as number,
      expectedNetBps: r.expected_net_bps as number,
      expectedUsd: r.expected_usd as number,
      settledTs: r.settled_ts as number | null,
      realizedNetBps: r.realized_net_bps as number | null,
      realizedUsd: r.realized_usd as number | null,
    };
  }

  openPaperEntry(
    e: Pick<PaperEntry, "openedTs" | "route" | "size" | "expectedNetBps" | "expectedUsd">,
  ): void {
    this.db
      .prepare(
        `INSERT INTO paper_entries (opened_ts, route, size, expected_net_bps, expected_usd)
         VALUES (@openedTs, @route, @size, @expectedNetBps, @expectedUsd)`,
      )
      .run(e as never);
  }

  pendingPaperEntries(): PaperEntry[] {
    return (
      this.db.prepare(`SELECT * FROM paper_entries WHERE settled_ts IS NULL`).all() as Record<
        string,
        unknown
      >[]
    ).map((r) => this.rowToPaper(r));
  }

  // realized null = unfillable (route vanished before we could land it)
  settlePaperEntry(
    id: number,
    settledTs: number,
    realizedNetBps: number | null,
    realizedUsd: number | null,
  ): void {
    this.db
      .prepare(
        `UPDATE paper_entries SET settled_ts = ?, realized_net_bps = ?, realized_usd = ? WHERE id = ?`,
      )
      .run(settledTs, realizedNetBps, realizedUsd, id);
  }

  recentPaperEntries(limit: number): PaperEntry[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM paper_entries WHERE settled_ts IS NOT NULL ORDER BY opened_ts DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]
    ).map((r) => this.rowToPaper(r));
  }

  clearPaperEntries(): void {
    this.db.exec(`DELETE FROM paper_entries`);
  }

  paperStats(sinceTs = 0): PaperStats {
    const settled = this.db
      .prepare(`SELECT * FROM paper_entries WHERE settled_ts IS NOT NULL AND opened_ts >= ?`)
      .all(sinceTs) as Record<string, unknown>[];
    const pending = (
      this.db.prepare(`SELECT COUNT(*) c FROM paper_entries WHERE settled_ts IS NULL`).get() as {
        c: number;
      }
    ).c;
    const filled = settled.filter((r) => r.realized_net_bps !== null);
    const n = filled.length;
    const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const exp = filled.map((r) => r.expected_net_bps as number);
    const real = filled.map((r) => r.realized_net_bps as number);
    return {
      settled: settled.length,
      filled: n,
      unfillable: settled.length - n,
      pending,
      meanExpectedBps: mean(exp),
      meanRealizedBps: mean(real),
      latencyTaxBps: mean(exp) - mean(real),
      hitRate: n ? real.filter((x) => x > 0).length / n : 0,
      realizedUsdTotal: filled.reduce((s, r) => s + (r.realized_usd as number), 0),
    };
  }
}
