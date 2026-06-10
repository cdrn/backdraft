import Database from "better-sqlite3";
import type { Episode } from "./derive/episodes.js";
import type { Quote } from "./types.js";

export class Store {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quotes (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        chain TEXT NOT NULL,
        venue TEXT NOT NULL,
        token_in TEXT NOT NULL,
        token_out TEXT NOT NULL,
        amount_in REAL NOT NULL,
        amount_out REAL NOT NULL,
        price REAL NOT NULL,
        bps REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quotes_ts ON quotes(ts);
      CREATE INDEX IF NOT EXISTS idx_quotes_chain_ts ON quotes(chain, ts);
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
    `);
    this.insertStmt = this.db.prepare(`
      INSERT INTO quotes (ts, chain, venue, token_in, token_out, amount_in, amount_out, price, bps)
      VALUES (@ts, @chain, @venue, @tokenIn, @tokenOut, @amountIn, @amountOut, @price, @bps)
    `);
  }

  insert(quotes: Quote[]): void {
    const tx = this.db.transaction((rows: Quote[]) => {
      for (const row of rows) this.insertStmt.run(row);
    });
    tx(quotes);
  }

  series(minutes: number, sizeUsd: number): unknown[] {
    return this.db
      .prepare(
        `SELECT ts, chain, venue, token_in AS tokenIn, token_out AS tokenOut,
                amount_in AS amountIn, price, bps
         FROM quotes
         WHERE ts >= ? AND amount_in = ?
         ORDER BY ts ASC`,
      )
      .all(Date.now() - minutes * 60_000, sizeUsd);
  }

  latest(): unknown[] {
    return this.db
      .prepare(
        `SELECT q.ts, q.chain, q.venue, q.token_in AS tokenIn, q.token_out AS tokenOut,
                q.amount_in AS amountIn, q.price, q.bps
         FROM quotes q
         JOIN (
           SELECT chain, token_in, token_out, amount_in, MAX(ts) AS max_ts
           FROM quotes GROUP BY chain, token_in, token_out, amount_in
         ) m ON q.chain = m.chain AND q.token_in = m.token_in
            AND q.token_out = m.token_out AND q.amount_in = m.amount_in
            AND q.ts = m.max_ts`,
      )
      .all();
  }

  quotesSince(
    ts: number,
  ): {
    ts: number;
    chain: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: number;
    price: number;
  }[] {
    return this.db
      .prepare(
        `SELECT ts, chain, token_in AS tokenIn, token_out AS tokenOut,
                amount_in AS amountIn, price
         FROM quotes WHERE ts >= ? ORDER BY ts ASC`,
      )
      .all(ts) as never;
  }

  allQuotesOrdered(): ReturnType<Store["quotesSince"]> {
    return this.quotesSince(0);
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
      this.db
        .prepare(`SELECT * FROM episodes WHERE closed_ts IS NULL`)
        .all() as Record<string, unknown>[]
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
        .prepare(
          `SELECT * FROM episodes WHERE opened_ts >= ? ORDER BY opened_ts ASC`,
        )
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
      .prepare(
        `UPDATE episodes SET peak_bps = ?, peak_size = ?, peak_usd = ?, last_ts = ? WHERE id = ?`,
      )
      .run(ep.peakBps, ep.peakSize, ep.peakUsd, ep.lastTs, ep.id);
  }

  touchEpisode(id: number, ts: number): void {
    this.db.prepare(`UPDATE episodes SET last_ts = ? WHERE id = ?`).run(ts, id);
  }

  closeEpisode(id: number, ts: number): void {
    this.db
      .prepare(`UPDATE episodes SET closed_ts = ? WHERE id = ?`)
      .run(ts, id);
  }

  clearEpisodes(): void {
    this.db.exec(`DELETE FROM episodes`);
  }
}
