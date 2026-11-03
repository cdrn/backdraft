import {
  CEX_EXEC,
  CEX_MAKER_BPS,
  CEX_TAKER_BPS,
  CHAINS,
  CLIPS_PER_REBALANCE,
  MAKER_ADVERSE_BPS,
  REBALANCE_FIXED_USD,
} from "./config.js";

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

// Full per-clip cost at a given size, in bps of notional. The DEX pool fee
// and both legs' price impact are NOT here — they're already inside the
// quote and the book walk respectively. This is only what sits outside the
// two prices.
export function clipCost(chain: string, cex: string, sizeUsd: number): CostBreakdown {
  const feeBps = cexFeeBps(cex);
  const gasBps = (gasUsd(chain) / sizeUsd) * 10_000;
  const rebalBps = (REBALANCE_FIXED_USD / CLIPS_PER_REBALANCE / sizeUsd) * 10_000;
  return { feeBps, gasBps, rebalBps, totalBps: feeBps + gasBps + rebalBps };
}
