// Cross-venue perp funding seismograph config. Sibling to the delta module:
// own DB, own port, own container so the funding dataset never gaps while
// the stablecoin scanner churns. Only permissionless / reachable venues —
// Binance & Bybit geoblock our IP, so the tradeable universe is the on-chain
// venues (Hyperliquid, dYdX v4) + OKX as an 8h-interval counterparty.

// Canonical underlyings tracked across every venue. The alt set is where the
// fat, sticky dispersion lives (majors have uniform funding). All verified to
// list on ≥3 of the 4 venues with the plain symbol name; a venue missing one
// just doesn't contribute to that pair. (PEPE/BONK excluded for now — HL
// k-prefixes them, kPEPE/kBONK, which needs a name+scale mapping.)
export const SYMBOLS = (
  process.env.FUNDING_SYMBOLS ??
  "BTC,ETH,SOL,AVAX,LINK,ARB,OP,DOGE,SUI,SEI,NEAR,APT,WIF,XRP,BNB,ADA"
).split(",");

export const FUNDING_POLL_INTERVAL_MS = Number(
  process.env.FUNDING_POLL_INTERVAL_MS ?? 60_000,
);

export const FUNDING_DB_PATH = process.env.FUNDING_DB_PATH ?? "funding.db";
export const FUNDING_PORT = Number(process.env.FUNDING_PORT ?? 4748);
export const FUNDING_PUBLIC_DIR =
  process.env.FUNDING_PUBLIC_DIR ?? "public/funding";

// Dispersion episode thresholds, in annualized % of the net carry spread
// (gross funding differential minus amortized round-trip fees).
export const DISPERSION_OPEN_PCT = Number(process.env.FUNDING_OPEN_PCT ?? 10);
export const DISPERSION_CLOSE_PCT = Number(process.env.FUNDING_CLOSE_PCT ?? 4);

// One-way TAKER exchange fee per venue (bps of notional), base tier. A
// delta-neutral pair pays entry+exit on BOTH legs, so round-trip cost =
// 2*(takerShort + takerLong). Verified base-tier figures (2026):
//   HL taker 0.045% = 4.5bps; dYdX/OKX ~0.05% = 5bps; Paradex API ~0.02% = 2bps
//   (retail Paradex is 0-fee; pro/API ~2bps). Maker fills are far cheaper
//   (HL 1.5bps, OKX 2bps, dYdX ~1bp, Paradex rebate) — a patient carry would
//   leg in maker and pay much less than this.
// NOTE — this models EXCHANGE FEES ONLY. It excludes the bid-ask spread you
// cross and slippage/market-impact, which on thin small venues are typically
// the DOMINANT round-trip cost. Those need the depth model, not this table.
export const VENUE_TAKER_BPS: Record<string, number> = {
  hyperliquid: 4.5,
  dydx: 5,
  okx: 5,
  paradex: 2,
  // "spot" is the synthetic hedge leg for cash-and-carry — a flat assumption
  // for buying/selling spot (CEX or on-chain). Depth-aware spot cost is a
  // follow-up; for now this is the taker estimate. Tunable via env.
  spot: Number(process.env.FUNDING_SPOT_TAKER_BPS ?? 5),
};

// Base-tier MAKER fees (bps). A patient carry trade rests limit orders rather
// than crossing the book — so it pays maker, captures the spread instead of
// crossing it, and skips the depth-impact that dominates taker cost on thin
// books. Paradex pays a maker rebate (negative). Verified base tiers (2026).
export const VENUE_MAKER_BPS: Record<string, number> = {
  hyperliquid: 1.5,
  dydx: 1,
  okx: 2,
  paradex: -0.5, // rebate
  spot: Number(process.env.FUNDING_SPOT_MAKER_BPS ?? 1),
};

// Maker fills aren't free even at small size: you wait to fill, get picked off
// by informed flow (adverse selection), and on a delta-neutral pair you carry
// leg risk while one side fills. This haircut (bps per maker leg) keeps the
// maker model honest instead of a rebate fantasy.
export const ADVERSE_SELECTION_BPS = Number(
  process.env.FUNDING_ADVERSE_BPS ?? 3,
);

// Execution model for fill costs:
//   taker  — cross the book: measured impact-from-mid + taker fee (pessimal)
//   maker  — rest limit orders: maker fee + adverse-selection haircut, no
//            depth crossing (optimistic — assumes you always get filled)
//   blend  — mean of the two: models maker-entry / taker-exit, partial fills,
//            and leg risk. The honest default.
export type ExecStyle = "taker" | "maker" | "blend";
export const FUNDING_EXEC_STYLE = (process.env.FUNDING_EXEC_STYLE ??
  "blend") as ExecStyle;

// Synthetic cash-and-carry hedge leg name (0% funding spot).
export const SPOT_VENUE_NAME = "spot";

// Assumed hold horizon used to amortize the one-time round-trip fee into an
// annualized drag. Short holds can't out-earn the fee — that's the whole
// point of measuring net, not gross.
export const ASSUMED_HOLD_DAYS = Number(process.env.FUNDING_HOLD_DAYS ?? 3);

// Paper ledger notional PER LEG (USD). A position is this much short on one
// venue and this much long on the other — delta-neutral, 2x capital tied up.
export const FUNDING_PAPER_NOTIONAL = Number(
  process.env.FUNDING_PAPER_NOTIONAL ?? 10_000,
);

// Anti-whipsaw controls. Funding (esp. dYdX's predicted rate) is noisy
// tick-to-tick and dips near each hourly settlement; without these the ledger
// chases spikes in and panic-sells dips out, paying round-trip fills for ~no
// carry. We smooth the spread (EMA), require the signal to PERSIST before
// acting at both ends, and never exit inside a minimum hold.
export const SPREAD_EMA_ALPHA = Number(process.env.FUNDING_SPREAD_EMA_ALPHA ?? 0.1);
export const OPEN_CONFIRM_TICKS = Number(process.env.FUNDING_OPEN_CONFIRM_TICKS ?? 10);
export const CLOSE_CONFIRM_TICKS = Number(process.env.FUNDING_CLOSE_CONFIRM_TICKS ?? 10);
export const MIN_HOLD_HOURS = Number(process.env.FUNDING_MIN_HOLD_HOURS ?? 6);
