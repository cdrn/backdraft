import { MAX_IMPACT_BPS, PAIRS } from "../config.js";
import { costBps, routeCost } from "../costs.js";

// Round-trip math per pair: buy the quote token with the base token on
// `from` (where it's cheap), sell it back on `to` (where it's rich). Gross
// is the product of the two executable legs; net subtracts the rebalance
// cost model. Net assumes inventory on both sides (instant capture,
// rebalance amortized) — the bridge-through trader pays the same costs but
// also carries `minutes` of spread risk.

export interface LatestQuote {
  chain: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  price: number;
}

export interface BoardCell {
  pair: string; // "USDC/USDT"
  from: string;
  to: string;
  size: number;
  grossBps: number;
  costBps: number;
  netBps: number;
  netUsd: number;
  minutes: number;
  via: string;
}

export function computeBoard(
  latest: LatestQuote[],
  chains: string[],
  sizes: number[],
): BoardCell[] {
  const px = (
    chain: string,
    tokenIn: string,
    tokenOut: string,
    size: number,
  ) =>
    latest.find(
      (q) =>
        q.chain === chain &&
        q.tokenIn === tokenIn &&
        q.tokenOut === tokenOut &&
        q.amountIn === size,
    )?.price;

  // Reference price per leg = the smallest-size quote. A leg whose price at
  // `size` degrades more than MAX_IMPACT_BPS from its reference is a thin
  // pool, not a tradeable dislocation — we drop those cells so the board and
  // paper ledger never count empty-pool fantasy as money.
  const refSize = Math.min(...sizes);
  const tooThin = (
    chain: string,
    tokenIn: string,
    tokenOut: string,
    size: number,
    price: number,
  ): boolean => {
    if (size === refSize) return false;
    const ref = px(chain, tokenIn, tokenOut, refSize);
    if (ref === undefined) return true; // can't verify depth → don't trust it
    return (ref - price) * 10_000 > MAX_IMPACT_BPS;
  };

  const cells: BoardCell[] = [];
  for (const pair of PAIRS) {
    const pairName = `${pair.base}/${pair.quote}`;
    for (const from of chains) {
      for (const to of chains) {
        if (from === to) continue;
        const rc = routeCost(pair.base, pair.quote, from, to);
        for (const size of sizes) {
          const buy = px(from, pair.base, pair.quote, size);
          const sell = px(to, pair.quote, pair.base, size);
          if (buy === undefined || sell === undefined) continue;
          if (tooThin(from, pair.base, pair.quote, size, buy)) continue;
          if (tooThin(to, pair.quote, pair.base, size, sell)) continue;
          const grossBps = (buy * sell - 1) * 10_000;
          const cost = costBps(rc, size);
          const netBps = grossBps - cost;
          cells.push({
            pair: pairName,
            from,
            to,
            size,
            grossBps,
            costBps: cost,
            netBps,
            netUsd: (netBps / 10_000) * size,
            minutes: rc.minutes,
            via: rc.via,
          });
        }
      }
    }
  }
  return cells;
}
