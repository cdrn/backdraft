// Cross-venue perp funding seismograph config. Sibling to the delta module:
// own DB, own port, own container so the funding dataset never gaps while
// the stablecoin scanner churns. Only permissionless / reachable venues —
// Binance & Bybit geoblock our IP, so the tradeable universe is the on-chain
// venues (Hyperliquid, dYdX v4) + OKX as an 8h-interval counterparty.

// Canonical underlyings tracked across every venue.
export const SYMBOLS = (process.env.FUNDING_SYMBOLS ?? "BTC,ETH,SOL").split(",");

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

// One-way taker fee per venue (bps of notional). A delta-neutral pair pays
// entry+exit on BOTH legs, so round-trip cost = 2*(takerShort + takerLong).
// Conservative public-tier estimates — revisit per venue fee schedule.
export const VENUE_TAKER_BPS: Record<string, number> = {
  hyperliquid: 2.5,
  dydx: 5,
  okx: 5,
};

// Assumed hold horizon used to amortize the one-time round-trip fee into an
// annualized drag. Short holds can't out-earn the fee — that's the whole
// point of measuring net, not gross.
export const ASSUMED_HOLD_DAYS = Number(process.env.FUNDING_HOLD_DAYS ?? 3);
