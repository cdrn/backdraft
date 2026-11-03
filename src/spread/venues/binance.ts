import type { Book, SpotVenue } from "../types.js";

// Binance.com spot depth. Returns HTTP 451 from US IPs — opt in via
// SPREAD_CEX when the collector runs somewhere it's reachable.
export class BinanceVenue implements SpotVenue {
  name = "binance";

  async fetchBook(symbol: string): Promise<Book | null> {
    const res = await fetch(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=50`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (res.status === 451) throw new Error("binance geoblocked (451)");
    if (!res.ok) throw new Error(`binance ${res.status}`);
    const body = (await res.json()) as { bids: string[][]; asks: string[][] };
    return {
      ts: Date.now(),
      venue: this.name,
      symbol,
      bids: body.bids.map(([p, s]) => [Number(p), Number(s)]),
      asks: body.asks.map(([p, s]) => [Number(p), Number(s)]),
    };
  }
}
