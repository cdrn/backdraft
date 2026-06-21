import {
  CLOSE_CONFIRM_TICKS,
  DISPERSION_CLOSE_PCT,
  DISPERSION_OPEN_PCT,
  FUNDING_PAPER_NOTIONAL,
  MIN_HOLD_HOURS,
  OPEN_CONFIRM_TICKS,
  SPREAD_EMA_ALPHA,
} from "../config.js";
import type { Store } from "../store.js";
import type { FundingSnapshot } from "../types.js";
import type { DispersionCell } from "./dispersion.js";
import { legCost } from "./exec.js";
import type { BookImpact } from "./impact.js";

// Carry-aware paper ledger — the honest "is this real money" test, without
// spending any. Unlike the delta ledger (open→settle next tick, a spatial
// arb), funding carry is a HELD position: open delta-neutral when net
// annualized clears a threshold, accrue funding every tick at the rates
// actually observed, track basis drift between the two legs' marks, and only
// realize at close, net of entry+exit fills on BOTH legs. The question it
// answers: does the carry out-earn the fee and the basis noise over the hold
// it actually took — not the hold we assumed.

export interface PaperPosition {
  id: number;
  symbol: string;
  shortVenue: string; // short here (was highest funding)
  longVenue: string; // long here (was lowest funding)
  openedTs: number;
  notional: number; // per leg
  entryShortAnn: number;
  entryLongAnn: number;
  entryShortPx: number;
  entryLongPx: number;
  carryPnl: number; // accumulated funding $ (running, updated each tick)
  lastAccrualTs: number;
  lastShortAnn: number; // last observed rates (display + accrual)
  lastLongAnn: number;
  feePaid: number; // entry fee (one side of the round trip)
  // set at close:
  closedTs: number | null;
  exitShortPx: number | null;
  exitLongPx: number | null;
  basisPnl: number | null; // mark divergence between legs ($) — the risk
  totalFee: number | null; // full round trip (entry + exit, both legs)
  totalPnl: number | null; // carry + basis − fees
  realizedAnnPct: number | null; // totalPnl/notional annualized over actual hold
}

export interface PaperStats {
  open: number;
  closed: number;
  openUnrealizedUsd: number; // carry so far − full round-trip fee (basis excluded; unpriced)
  closedCarryUsd: number;
  closedBasisUsd: number;
  closedFeesUsd: number;
  closedNetUsd: number;
  meanRealizedAnnPct: number;
  meanHoldDays: number;
  winRate: number; // fraction of closed positions net-positive
}

// one-leg fill cost via the shared execution-cost model (taker/maker/blend) —
// the same function the board uses, so ledger and board can't drift.
const legFillBps = legCost;

export class PaperLedger {
  // in-memory anti-whipsaw state (resets on restart, which is safe — counters
  // just re-accumulate before any action fires).
  private posState = new Map<number, { smoothed: number; belowTicks: number }>();
  private aboveOpenTicks = new Map<string, number>();

  constructor(
    private store: Store,
    private openPct = DISPERSION_OPEN_PCT,
    private closePct = DISPERSION_CLOSE_PCT,
    private notional = FUNDING_PAPER_NOTIONAL,
  ) {}

  update(
    board: DispersionCell[],
    snaps: FundingSnapshot[],
    impacts: BookImpact[],
    ts: number,
  ): void {
    const snap = (venue: string, symbol: string) =>
      snaps.find((s) => s.venue === venue && s.symbol === symbol);
    const impMap = new Map<string, BookImpact>();
    for (const i of impacts) impMap.set(`${i.venue}|${i.symbol}`, i);
    const imp = (venue: string, symbol: string) =>
      impMap.get(`${venue}|${symbol}`);

    // 1. accrue carry on open positions, then close any whose edge compressed.
    for (const pos of this.store.openPaperPositions()) {
      const s = snap(pos.shortVenue, pos.symbol);
      const l = snap(pos.longVenue, pos.symbol);
      if (!s || !l) continue; // can't price this tick → leave untouched

      // carry over elapsed wall-clock at the currently observed rates.
      // annualizedPct/100 is the yearly fraction; × dt/8760 = elapsed share.
      const dtHours = (ts - pos.lastAccrualTs) / 3_600_000;
      if (dtHours > 0) {
        pos.carryPnl +=
          pos.notional *
          ((s.annualizedPct - l.annualizedPct) / 100) *
          (dtHours / 8760);
      }
      this.store.accruePaperPosition(
        pos.id,
        pos.carryPnl,
        ts,
        s.annualizedPct,
        l.annualizedPct,
      );

      // Exit only on a PERSISTENT, smoothed compression — never on a single
      // noisy tick or inside the minimum hold. Smooth the spread (EMA), count
      // consecutive ticks the smoothed value sits below the close threshold,
      // and require both the min-hold and the confirm window before closing.
      const rawSpread = s.annualizedPct - l.annualizedPct;
      const st = this.posState.get(pos.id) ?? { smoothed: rawSpread, belowTicks: 0 };
      st.smoothed += SPREAD_EMA_ALPHA * (rawSpread - st.smoothed);
      st.belowTicks = st.smoothed < this.closePct ? st.belowTicks + 1 : 0;
      this.posState.set(pos.id, st);

      const holdHours = (ts - pos.openedTs) / 3_600_000;
      const shouldClose =
        holdHours >= MIN_HOLD_HOURS && st.belowTicks >= CLOSE_CONFIRM_TICKS;
      if (shouldClose) {
        this.posState.delete(pos.id);
        const sPx = s.markPx ?? pos.entryShortPx;
        const lPx = l.markPx ?? pos.entryLongPx;
        // short profits when its mark falls, long when its mark rises; if both
        // legs tracked the index identically this is ~0 — the residual is basis.
        const basisFrac =
          (pos.entryShortPx - sPx) / pos.entryShortPx +
          (lPx - pos.entryLongPx) / pos.entryLongPx;
        const basisPnl = pos.notional * basisFrac;
        // exit fills: buy back the short leg, sell the long leg.
        const exitBps =
          legFillBps(imp(pos.shortVenue, pos.symbol), pos.shortVenue, "buy", pos.notional).bps +
          legFillBps(imp(pos.longVenue, pos.symbol), pos.longVenue, "sell", pos.notional).bps;
        const totalFee = pos.feePaid + (exitBps / 10_000) * pos.notional;
        const totalPnl = pos.carryPnl + basisPnl - totalFee;
        const holdDays = (ts - pos.openedTs) / 86_400_000;
        const realizedAnnPct =
          holdDays > 0 ? (totalPnl / pos.notional) * (365 / holdDays) * 100 : 0;
        this.store.closePaperPosition(pos.id, {
          closedTs: ts,
          exitShortPx: sPx,
          exitLongPx: lPx,
          basisPnl,
          totalFee,
          totalPnl,
          realizedAnnPct,
        });
      }
    }

    // 2. open a position for each symbol clearing the open threshold that has
    //    no open position yet. Need marks on both legs to track basis.
    const openSymbols = new Set(
      this.store.openPaperPositions().map((p) => p.symbol),
    );
    for (const c of board) {
      // track persistence: how many consecutive ticks this opportunity has
      // held above the open threshold. Reset the moment it drops.
      const above = c.netAnnPct >= this.openPct;
      this.aboveOpenTicks.set(
        c.symbol,
        above ? (this.aboveOpenTicks.get(c.symbol) ?? 0) + 1 : 0,
      );
      if (!above || openSymbols.has(c.symbol)) continue;
      // require the edge to have PERSISTED, not just spiked this tick
      if ((this.aboveOpenTicks.get(c.symbol) ?? 0) < OPEN_CONFIRM_TICKS) continue;
      const s = snap(c.shortVenue, c.symbol);
      const l = snap(c.longVenue, c.symbol);
      if (!s?.markPx || !l?.markPx) continue;
      // entry fills: sell the short-leg venue, buy the long-leg venue. If
      // either book exists but is too thin to fill the notional, the position
      // isn't actually executable — don't open it.
      const sellShort = legFillBps(imp(c.shortVenue, c.symbol), c.shortVenue, "sell", this.notional);
      const buyLong = legFillBps(imp(c.longVenue, c.symbol), c.longVenue, "buy", this.notional);
      if (sellShort.thin || buyLong.thin) continue;
      const entryFee = ((sellShort.bps + buyLong.bps) / 10_000) * this.notional;
      this.store.openPaperPosition({
        symbol: c.symbol,
        shortVenue: c.shortVenue,
        longVenue: c.longVenue,
        openedTs: ts,
        notional: this.notional,
        entryShortAnn: s.annualizedPct,
        entryLongAnn: l.annualizedPct,
        entryShortPx: s.markPx,
        entryLongPx: l.markPx,
        carryPnl: 0,
        lastAccrualTs: ts,
        lastShortAnn: s.annualizedPct,
        lastLongAnn: l.annualizedPct,
        feePaid: entryFee,
      });
      openSymbols.add(c.symbol);
    }
  }
}
