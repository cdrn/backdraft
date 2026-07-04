import { annualizedPct } from "../types.js";
import type { FundingSnapshot, FundingVenue } from "../types.js";

// Arcus (Robinhood Chain) — dYdX-Labs' new permissionless perp venue, public
// keyless API. One GET returns every market. Its value here is the markets no
// one else lists: 26 EQUITY perps (AAPL, NVDA, TSLA, COIN, MSTR, HOOD…), plus
// commodities (GLD/SLV/USO) and indices (SPY/QQQ) — funding on underlyings
// HL/dYdX/OKX don't carry. It also lists the majors (BTC/ETH/SOL), so it joins
// the cross-venue crypto board as an extra leg for free.
//
// Unlike the other venues we DON'T filter to the global crypto SYMBOLS — we
// return Arcus's whole online universe so the RWA-perp funding series
// accumulates. The board/ledger still only derive over SYMBOLS, so equities
// persist as raw funding history without polluting the crypto dispersion.
//
// Interval: dYdX v4 heritage + observed sub-hour time-to-next-funding →
// hourly. Treated as a config assumption (env override); a wrong interval is a
// cheap fix + backfill of annualizedPct, never a re-collection (raw rate is
// source of truth).
const ARCUS_INTERVAL_HOURS = Number(
  process.env.FUNDING_ARCUS_INTERVAL_HOURS ?? 1,
);

interface ArcusMarket {
  marketDisplayName?: string;
  baseAsset?: string;
  status?: string;
  type?: string;
  category?: string;
  oraclePrice?: string | number;
  markPrice?: string | number;
  fundingRate?: string | number;
}

export class ArcusVenue implements FundingVenue {
  name = "arcus";
  intervalHours = ARCUS_INTERVAL_HOURS;

  // symbols arg is intentionally ignored — see file header.
  async poll(_symbols: string[]): Promise<FundingSnapshot[]> {
    const res = await fetch("https://api.arcus.xyz/v1/markets", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`arcus ${res.status}`);
    const body = (await res.json()) as
      | Record<string, ArcusMarket>
      | { markets?: ArcusMarket[] };

    const markets: ArcusMarket[] = Array.isArray((body as any).markets)
      ? (body as any).markets
      : Object.values(body as Record<string, ArcusMarket>);

    const ts = Date.now();
    const out: FundingSnapshot[] = [];
    for (const m of markets) {
      if (!m || typeof m !== "object") continue;
      if (m.status && m.status !== "ONLINE") continue;
      const symbol =
        m.baseAsset ?? m.marketDisplayName?.replace(/-USD$/, "");
      if (!symbol) continue;
      const oracle = Number(m.oraclePrice ?? 0);
      const mark = Number(m.markPrice ?? 0);
      const px = oracle > 0 ? oracle : mark;
      if (!(px > 0)) continue; // skip not-yet-live markets (price 0.0000)
      if (m.fundingRate == null) continue;
      const rate = Number(m.fundingRate);
      if (!Number.isFinite(rate)) continue;
      out.push({
        ts,
        venue: this.name,
        symbol,
        fundingRate: rate,
        intervalHours: this.intervalHours,
        annualizedPct: annualizedPct(rate, this.intervalHours),
        markPx: px,
      });
    }
    return out;
  }
}
