import {
  ATOMIC_TIP_BPS,
  CEX_EXEC,
  CEX_MAKER_BPS,
  CEX_TAKER_BPS,
  CHAINS,
  CLIPS_PER_REBALANCE,
  MAKER_ADVERSE_BPS,
  REBALANCE_FIXED_USD,
} from "./config.js";
import { chainOf, isDexVenue } from "./types.js";

export interface CostBreakdown {
  feeBps: number;
  gasBps: number;
  rebalBps: number;
  totalBps: number;
}

export function cexFeeBps(venue: string): number {
  if (CEX_EXEC === "maker") {
    return (CEX_MAKER_BPS[venue] ?? 10) + MAKER_ADVERSE_BPS;
  }
  return CEX_TAKER_BPS[venue] ?? 10;
}

export function gasUsd(chain: string): number {
  return CHAINS.find((c) => c.name === chain)?.gasUsdPerSwap ?? 1;
}

// Full per-clip cost at a given size, in bps of notional, for buying on
// `buy` and selling on `sell`. The DEX pool fee and both legs' price impact
// are NOT here — they're already inside the quote and the book walk
// respectively. This is only what sits outside the two prices.
//
//   CEX leg      one-way fee per CEX touched
//   DEX leg      one swap's gas per DEX touched
//   inventory    rebalance amortised per clip — unless both legs are on the
//                same chain (atomic, starts and ends in USDC in one tx)
//   atomic       builder tip on the dex→dex bundle
export function clipCost(buy: string, sell: string, sizeUsd: number): CostBreakdown {
  let feeBps = 0;
  let gasUsdTotal = 0;
  for (const v of [buy, sell]) {
    if (isDexVenue(v)) gasUsdTotal += gasUsd(chainOf(v));
    else feeBps += cexFeeBps(v);
  }
  const atomic = isDexVenue(buy) && isDexVenue(sell) && chainOf(buy) === chainOf(sell);
  const gasBps = (gasUsdTotal / sizeUsd) * 10_000 + (atomic ? ATOMIC_TIP_BPS : 0);
  const rebalBps = atomic ? 0 : (REBALANCE_FIXED_USD / CLIPS_PER_REBALANCE / sizeUsd) * 10_000;
  return { feeBps, gasBps, rebalBps, totalBps: feeBps + gasBps + rebalBps };
}
