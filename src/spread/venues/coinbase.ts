import type { Book, SpotVenue } from "../types.js";

// Coinbase Exchange public order book. Level 2 is the FULL aggregated book
// (no size parameter; ~100 KB per pull) — the collector trims it before
// storing. Keyless.
export class CoinbaseVenue implements SpotVenue {
  name = "coinbase";

  async fetchBook(symbol: string): Promise<Book | null> {
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/${symbol}/book?level=2`,
      {
        headers: { "User-Agent": "backdraft-spread", Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`coinbase ${res.status}`);
    const body = (await res.json()) as {
      bids: [string, string, number][];
      asks: [string, string, number][];
    };
    return {
      ts: Date.now(),
      venue: this.name,
      symbol,
      bids: body.bids.map(([p, s]) => [Number(p), Number(s)]),
      asks: body.asks.map(([p, s]) => [Number(p), Number(s)]),
    };
  }
}
