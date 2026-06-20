import { annualizedPct } from "../types.js";
import type { FundingSnapshot, FundingVenue } from "../types.js";

// OKX: 8h funding — the interval-mismatch counterparty to the hourly on-chain
// venues, where the structural dispersion lives. Funding rate and mark price
// are separate per-instrument endpoints, so we fetch both per symbol.
const INST = (sym: string) => `${sym}-USDT-SWAP`;

export class OkxVenue implements FundingVenue {
  name = "okx";
  intervalHours = 8;

  private async json(url: string): Promise<{ data?: unknown[] }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`okx ${res.status} ${url}`);
    return (await res.json()) as { data?: unknown[] };
  }

  async poll(symbols: string[]): Promise<FundingSnapshot[]> {
    const ts = Date.now();
    const out: FundingSnapshot[] = [];
    for (const sym of symbols) {
      const inst = INST(sym);
      try {
        const fr = await this.json(
          `https://www.okx.com/api/v5/public/funding-rate?instId=${inst}`,
        );
        const f = (fr.data?.[0] ?? {}) as { fundingRate?: string };
        if (!f.fundingRate) continue;
        const rate = Number(f.fundingRate);

        const mp = await this.json(
          `https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${inst}`,
        );
        const m = (mp.data?.[0] ?? {}) as { markPx?: string };

        out.push({
          ts,
          venue: this.name,
          symbol: sym,
          fundingRate: rate,
          intervalHours: this.intervalHours,
          annualizedPct: annualizedPct(rate, this.intervalHours),
          markPx: m.markPx ? Number(m.markPx) : null,
        });
      } catch (err) {
        console.error(
          `[okx] ${sym}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return out;
  }
}
