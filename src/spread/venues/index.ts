import type { SpotVenue } from "../types.js";
import { BinanceVenue } from "./binance.js";
import { CoinbaseVenue } from "./coinbase.js";
import { OkxVenue } from "./okx.js";

const REGISTRY: Record<string, () => SpotVenue> = {
  coinbase: () => new CoinbaseVenue(),
  okx: () => new OkxVenue(),
  binance: () => new BinanceVenue(),
};

export function buildVenues(names: string[]): SpotVenue[] {
  const out: SpotVenue[] = [];
  for (const n of names) {
    const make = REGISTRY[n];
    if (!make) {
      console.warn(`[spread] unknown CEX venue "${n}" — skipped`);
      continue;
    }
    out.push(make());
  }
  return out;
}
