import Database from "better-sqlite3";
import type { PaperPosition, PaperStats } from "./derive/paper.js";
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
      CREATE TABLE IF NOT EXISTS paper_positions (
        id INTEGER PRIMARY KEY,
        symbol TEXT NOT NULL,
        short_venue TEXT NOT NULL,
        long_venue TEXT NOT NULL,
        opened_ts INTEGER NOT NULL,
        notional REAL NOT NULL,
        entry_short_ann REAL NOT NULL,
        entry_long_ann REAL NOT NULL,
        entry_short_px REAL NOT NULL,
        entry_long_px REAL NOT NULL,
        carry_pnl REAL NOT NULL,
        last_accrual_ts INTEGER NOT NULL,
        last_short_ann REAL NOT NULL,
        last_long_ann REAL NOT NULL,
        fee_paid REAL NOT NULL,
        closed_ts INTEGER,
        exit_short_px REAL,
        exit_long_px REAL,
        basis_pnl REAL,
        total_fee REAL,
        total_pnl REAL,
        realized_ann_pct REAL
      );
      CREATE INDEX IF NOT EXISTS idx_paper_open ON paper_positions(closed_ts);
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

  // ---- paper ledger ----

  private rowToPosition(r: Record<string, unknown>): PaperPosition {
    return {
      id: r.id as number,
      symbol: r.symbol as string,
      shortVenue: r.short_venue as string,
      longVenue: r.long_venue as string,
      openedTs: r.opened_ts as number,
      notional: r.notional as number,
      entryShortAnn: r.entry_short_ann as number,
      entryLongAnn: r.entry_long_ann as number,
      entryShortPx: r.entry_short_px as number,
      entryLongPx: r.entry_long_px as number,
      carryPnl: r.carry_pnl as number,
      lastAccrualTs: r.last_accrual_ts as number,
      lastShortAnn: r.last_short_ann as number,
      lastLongAnn: r.last_long_ann as number,
      feePaid: r.fee_paid as number,
      closedTs: r.closed_ts as number | null,
      exitShortPx: r.exit_short_px as number | null,
      exitLongPx: r.exit_long_px as number | null,
      basisPnl: r.basis_pnl as number | null,
      totalFee: r.total_fee as number | null,
      totalPnl: r.total_pnl as number | null,
      realizedAnnPct: r.realized_ann_pct as number | null,
    };
  }

  openPaperPosition(
    p: Omit<
      PaperPosition,
      | "id"
      | "closedTs"
      | "exitShortPx"
      | "exitLongPx"
      | "basisPnl"
      | "totalFee"
      | "totalPnl"
      | "realizedAnnPct"
    >,
  ): void {
    this.db
      .prepare(
        `INSERT INTO paper_positions
          (symbol, short_venue, long_venue, opened_ts, notional,
           entry_short_ann, entry_long_ann, entry_short_px, entry_long_px,
           carry_pnl, last_accrual_ts, last_short_ann, last_long_ann, fee_paid)
         VALUES
          (@symbol, @shortVenue, @longVenue, @openedTs, @notional,
           @entryShortAnn, @entryLongAnn, @entryShortPx, @entryLongPx,
           @carryPnl, @lastAccrualTs, @lastShortAnn, @lastLongAnn, @feePaid)`,
      )
      .run(p as never);
  }

  openPaperPositions(): PaperPosition[] {
    return (
      this.db
        .prepare(`SELECT * FROM paper_positions WHERE closed_ts IS NULL`)
        .all() as Record<string, unknown>[]
    ).map((r) => this.rowToPosition(r));
  }

  accruePaperPosition(
    id: number,
    carryPnl: number,
    lastAccrualTs: number,
    lastShortAnn: number,
    lastLongAnn: number,
  ): void {
    this.db
      .prepare(
        `UPDATE paper_positions
         SET carry_pnl = ?, last_accrual_ts = ?, last_short_ann = ?, last_long_ann = ?
         WHERE id = ?`,
      )
      .run(carryPnl, lastAccrualTs, lastShortAnn, lastLongAnn, id);
  }

  closePaperPosition(
    id: number,
    c: {
      closedTs: number;
      exitShortPx: number;
      exitLongPx: number;
      basisPnl: number;
      totalFee: number;
      totalPnl: number;
      realizedAnnPct: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE paper_positions
         SET closed_ts = ?, exit_short_px = ?, exit_long_px = ?,
             basis_pnl = ?, total_fee = ?, total_pnl = ?, realized_ann_pct = ?
         WHERE id = ?`,
      )
      .run(
        c.closedTs,
        c.exitShortPx,
        c.exitLongPx,
        c.basisPnl,
        c.totalFee,
        c.totalPnl,
        c.realizedAnnPct,
        id,
      );
  }

  recentClosedPaperPositions(limit: number): PaperPosition[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM paper_positions WHERE closed_ts IS NOT NULL
           ORDER BY closed_ts DESC LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[]
    ).map((r) => this.rowToPosition(r));
  }

  paperStats(): PaperStats {
    const open = this.openPaperPositions();
    const closed = (
      this.db
        .prepare(`SELECT * FROM paper_positions WHERE closed_ts IS NOT NULL`)
        .all() as Record<string, unknown>[]
    ).map((r) => this.rowToPosition(r));

    // open unrealized: carry so far minus the full round trip you'd pay to
    // realize it. Basis is excluded — it's unpriced without current marks.
    const openUnrealizedUsd = open.reduce(
      (s, p) => s + (p.carryPnl - 2 * p.feePaid),
      0,
    );

    const n = closed.length;
    const mean = (a: number[]) =>
      a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    return {
      open: open.length,
      closed: n,
      openUnrealizedUsd,
      closedCarryUsd: closed.reduce((s, p) => s + p.carryPnl, 0),
      closedBasisUsd: closed.reduce((s, p) => s + (p.basisPnl ?? 0), 0),
      closedFeesUsd: closed.reduce((s, p) => s + (p.totalFee ?? 0), 0),
      closedNetUsd: closed.reduce((s, p) => s + (p.totalPnl ?? 0), 0),
      meanRealizedAnnPct: mean(closed.map((p) => p.realizedAnnPct ?? 0)),
      meanHoldDays: mean(
        closed.map((p) => ((p.closedTs ?? 0) - p.openedTs) / 86_400_000),
      ),
      winRate: n ? closed.filter((p) => (p.totalPnl ?? 0) > 0).length / n : 0,
    };
  }
}
