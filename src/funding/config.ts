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
};

// Assumed hold horizon used to amortize the one-time round-trip fee into an
// annualized drag. Short holds can't out-earn the fee — that's the whole
// point of measuring net, not gross.
export const ASSUMED_HOLD_DAYS = Number(process.env.FUNDING_HOLD_DAYS ?? 3);

// Paper ledger notional PER LEG (USD). A position is this much short on one
// venue and this much long on the other — delta-neutral, 2x capital tied up.
export const FUNDING_PAPER_NOTIONAL = Number(
  process.env.FUNDING_PAPER_NOTIONAL ?? 10_000,
);
