import { annualizedPct } from "../types.js";
import type { FundingSnapshot, FundingVenue, RawBook } from "../types.js";

// Hyperliquid: hourly funding. One POST returns the whole universe + per-asset
// contexts (funding rate, mark price), so a single call covers all symbols.
export class HyperliquidVenue implements FundingVenue {
  name = "hyperliquid";
  intervalHours = 1;

  async poll(symbols: string[]): Promise<FundingSnapshot[]> {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    });
    if (!res.ok) throw new Error(`hyperliquid ${res.status}`);
    const [meta, ctxs] = (await res.json()) as [
      { universe: { name: string }[] },
      { funding: string; markPx: string }[],
    ];
    const ts = Date.now();
    const out: FundingSnapshot[] = [];
    for (let i = 0; i < meta.universe.length; i++) {
      const sym = meta.universe[i].name;
      if (!symbols.includes(sym)) continue;
      const ctx = ctxs[i];
      if (!ctx?.funding) continue;
      const rate = Number(ctx.funding);
      out.push({
        ts,
        venue: this.name,
        symbol: sym,
        fundingRate: rate,
        intervalHours: this.intervalHours,
        annualizedPct: annualizedPct(rate, this.intervalHours),
        markPx: ctx.markPx ? Number(ctx.markPx) : null,
      });
    }
    return out;
  }

  // l2Book.levels = [bids, asks]; each level {px, sz}.
  async fetchBook(symbol: string): Promise<RawBook | null> {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin: symbol }),
    });
    if (!res.ok) throw new Error(`hyperliquid book ${res.status}`);
    const { levels } = (await res.json()) as {
      levels: { px: string; sz: string }[][];
    };
    if (!levels?.[0] || !levels?.[1]) return null;
    const map = (l: { px: string; sz: string }[]): [number, number][] =>
      l.map((x) => [Number(x.px), Number(x.sz)]);
    return { bids: map(levels[0]), asks: map(levels[1]) };
  }
}
