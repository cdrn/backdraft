import { annualizedPct } from "../types.js";
import type { FundingSnapshot, FundingVenue } from "../types.js";

// Paradex (StarkNet, Paradigm-backed) — a small, isolated perp DEX with its
// own funding regime, exactly the kind of venue that drifts off the majors.
// Self-describing funding: the summary returns `funding_rate` (an 8-hour rate,
// matching its `funding_rate_8h` field) and markets run an 8h funding period.
// One call returns every market; we filter to ours.
const MARKET = (sym: string) => `${sym}-USD-PERP`;
const CANON: Record<string, string> = {
  "BTC-USD-PERP": "BTC",
  "ETH-USD-PERP": "ETH",
  "SOL-USD-PERP": "SOL",
};

export class ParadexVenue implements FundingVenue {
  name = "paradex";
  intervalHours = 8; // verified via funding_period_hours=8 on the funding feed

  async poll(symbols: string[]): Promise<FundingSnapshot[]> {
    const res = await fetch(
      "https://api.prod.paradex.trade/v1/markets/summary?market=ALL",
    );
    if (!res.ok) throw new Error(`paradex ${res.status}`);
    const { results } = (await res.json()) as {
      results?: { symbol: string; funding_rate?: string; mark_price?: string }[];
    };
    const want = new Set(symbols.map(MARKET));
    const ts = Date.now();
    const out: FundingSnapshot[] = [];
    for (const r of results ?? []) {
      if (!want.has(r.symbol) || r.funding_rate == null) continue;
      const rate = Number(r.funding_rate);
      if (!Number.isFinite(rate)) continue;
      const sym = CANON[r.symbol] ?? r.symbol.split("-")[0];
      out.push({
        ts,
        venue: this.name,
        symbol: sym,
        fundingRate: rate,
        intervalHours: this.intervalHours,
        annualizedPct: annualizedPct(rate, this.intervalHours),
        markPx: r.mark_price ? Number(r.mark_price) : null,
      });
    }
    return out;
  }
}
