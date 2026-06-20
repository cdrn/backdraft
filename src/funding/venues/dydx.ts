import { annualizedPct } from "../types.js";
import type { FundingSnapshot, FundingVenue } from "../types.js";

// dYdX v4: hourly funding, settled every hour. The indexer exposes the
// predicted next-hour rate as `nextFundingRate` and an oracle price per
// market. One call returns every market; we filter to our symbols.
//
// VERIFIED hourly: /v4/historicalFunding/ETH-USD returns realized rates
// spaced exactly 1.00h apart (~6.9e-5 each), so nextFundingRate is a 1-hour
// rate and intervalHours=1 is correct. Large annualized spreads vs hourly HL
// are therefore real dispersion, not a units artifact — judge capturability
// in the paper ledger, not here.
const TICKER = (sym: string) => `${sym}-USD`;

export class DydxVenue implements FundingVenue {
  name = "dydx";
  intervalHours = 1;

  async poll(symbols: string[]): Promise<FundingSnapshot[]> {
    const res = await fetch(
      "https://indexer.dydx.trade/v4/perpetualMarkets",
    );
    if (!res.ok) throw new Error(`dydx ${res.status}`);
    const { markets } = (await res.json()) as {
      markets: Record<
        string,
        { nextFundingRate?: string; oraclePrice?: string }
      >;
    };
    const ts = Date.now();
    const out: FundingSnapshot[] = [];
    for (const sym of symbols) {
      const m = markets[TICKER(sym)];
      if (!m?.nextFundingRate) continue;
      const rate = Number(m.nextFundingRate);
      out.push({
        ts,
        venue: this.name,
        symbol: sym,
        fundingRate: rate,
        intervalHours: this.intervalHours,
        annualizedPct: annualizedPct(rate, this.intervalHours),
        markPx: m.oraclePrice ? Number(m.oraclePrice) : null,
      });
    }
    return out;
  }
}
