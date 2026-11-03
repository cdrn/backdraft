import type { Book, SpotVenue } from "../types.js";

// OKX spot order book, up to 400 levels keyless; we ask for 50.
export class OkxVenue implements SpotVenue {
  name = "okx";

  async fetchBook(symbol: string): Promise<Book | null> {
    const res = await fetch(
      `https://www.okx.com/api/v5/market/books?instId=${symbol}&sz=50`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) throw new Error(`okx ${res.status}`);
    const body = (await res.json()) as {
      code: string;
      data?: { bids: string[][]; asks: string[][] }[];
    };
    const d = body.data?.[0];
    if (body.code !== "0" || !d) return null;
    return {
      ts: Date.now(),
      venue: this.name,
      symbol,
      bids: d.bids.map(([p, s]) => [Number(p), Number(s)]),
      asks: d.asks.map(([p, s]) => [Number(p), Number(s)]),
    };
  }
}
