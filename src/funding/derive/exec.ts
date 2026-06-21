import {
  ADVERSE_SELECTION_BPS,
  FUNDING_EXEC_STYLE,
  SPOT_VENUE_NAME,
  VENUE_MAKER_BPS,
  VENUE_TAKER_BPS,
  type ExecStyle,
} from "../config.js";
import { impactAt, type BookImpact } from "./impact.js";

// Single source of truth for one-leg fill cost (bps), shared by the board
// (dispersion) and the paper ledger so they can never drift. Three models:
//
//  • taker — cross the book: measured impact-from-mid (spread + depth) + taker
//    fee. Deterministic and pessimal; the wrong baseline for a position you
//    intend to HOLD for days.
//  • maker — rest a limit order: maker fee + an adverse-selection haircut, and
//    crucially NO depth-crossing term (a resting order provides liquidity, it
//    doesn't consume it). Optimistic — assumes you always get filled.
//  • blend — mean of the two: a stand-in for maker-entry / taker-exit, partial
//    fills, and the leg risk of a two-sided hedge. The honest default.
//
// `thin` is driven off the taker side: if the book exists but can't absorb the
// notional even by crossing, the venue isn't viable at that size — true
// regardless of style, so we still refuse to open there.

export interface LegCost {
  bps: number;
  thin: boolean;
}

export function legCost(
  imp: BookImpact | undefined,
  venue: string,
  side: "buy" | "sell",
  notional: number,
  style: ExecStyle = FUNDING_EXEC_STYLE,
): LegCost {
  const taker = VENUE_TAKER_BPS[venue] ?? 5;
  const maker = (VENUE_MAKER_BPS[venue] ?? 1) + ADVERSE_SELECTION_BPS;

  // spot has no modeled book — flat fee assumption, never thin.
  if (venue === SPOT_VENUE_NAME) {
    const bps = style === "taker" ? taker : style === "maker" ? maker : (taker + maker) / 2;
    return { bps, thin: false };
  }

  // no book fetched this tick → fall back to flat taker, don't punish.
  if (!imp) {
    const bps = style === "maker" ? maker : taker;
    return { bps, thin: false };
  }

  const crossBps = impactAt(imp, side, notional); // bps from mid to cross
  const thin = crossBps === null; // book exists but can't fill at size
  const takerCost = thin ? taker : (crossBps as number) + taker;
  const bps =
    style === "taker" ? takerCost : style === "maker" ? maker : (takerCost + maker) / 2;
  return { bps, thin };
}
