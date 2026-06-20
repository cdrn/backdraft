import Database from "better-sqlite3";
import type { FundingSnapshot } from "./types.js";

// Raw funding snapshots are the source of truth — everything (annualized %,
// dispersion board, future carry ledger) is recomputable from these, so a
// model/interval change is a re-derive, never a re-collect.
export class Store {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS funding_snapshots (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        venue TEXT NOT NULL,
        symbol TEXT NOT NULL,
        funding_rate REAL NOT NULL,
        interval_hours REAL NOT NULL,
        annualized_pct REAL NOT NULL,
        mark_px REAL
      );
      CREATE INDEX IF NOT EXISTS idx_funding_ts ON funding_snapshots(ts);
      CREATE INDEX IF NOT EXISTS idx_funding_sym_ts ON funding_snapshots(symbol, ts);
    `);
    this.insertStmt = this.db.prepare(`
      INSERT INTO funding_snapshots
        (ts, venue, symbol, funding_rate, interval_hours, annualized_pct, mark_px)
      VALUES
        (@ts, @venue, @symbol, @fundingRate, @intervalHours, @annualizedPct, @markPx)
    `);
  }

  insert(snaps: FundingSnapshot[]): void {
    const tx = this.db.transaction((rows: FundingSnapshot[]) => {
      for (const row of rows) this.insertStmt.run(row);
    });
    tx(snaps);
  }

  // Most recent snapshot per (venue, symbol) — feeds the live board.
  latest(): FundingSnapshot[] {
    return this.db
      .prepare(
        `SELECT f.ts, f.venue, f.symbol, f.funding_rate AS fundingRate,
                f.interval_hours AS intervalHours, f.annualized_pct AS annualizedPct,
                f.mark_px AS markPx
         FROM funding_snapshots f
         JOIN (
           SELECT venue, symbol, MAX(ts) AS max_ts
           FROM funding_snapshots GROUP BY venue, symbol
         ) m ON f.venue = m.venue AND f.symbol = m.symbol AND f.ts = m.max_ts`,
      )
      .all() as FundingSnapshot[];
  }

  series(minutes: number): FundingSnapshot[] {
    return this.db
      .prepare(
        `SELECT ts, venue, symbol, funding_rate AS fundingRate,
                interval_hours AS intervalHours, annualized_pct AS annualizedPct,
                mark_px AS markPx
         FROM funding_snapshots WHERE ts >= ? ORDER BY ts ASC`,
      )
      .all(Date.now() - minutes * 60_000) as FundingSnapshot[];
  }
}
