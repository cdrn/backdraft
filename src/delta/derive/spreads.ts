import { costBps, routeCost } from "../costs.js";

// Round-trip math: buy USDT with USDC on `from` (where USDT is cheap),
// sell USDT for USDC on `to` (where it's rich). Gross is the product of the
// two executable legs; net subtracts the rebalance cost model. Net assumes
// inventory on both sides (instant capture, rebalance amortized) — the
// bridge-through trader pays the same costs but also carries `minutes` of
// spread risk.

export interface LatestQuote {
  chain: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  price: number;
}

export interface BoardCell {
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
  const px = (chain: string, tokenIn: string, size: number) =>
    latest.find(
      (q) => q.chain === chain && q.tokenIn === tokenIn && q.amountIn === size,
    )?.price;

  const cells: BoardCell[] = [];
  for (const from of chains) {
    for (const to of chains) {
      if (from === to) continue;
      const rc = routeCost(from, to);
      for (const size of sizes) {
        const buy = px(from, "USDC", size); // USDT per USDC on `from`
        const sell = px(to, "USDT", size); // USDC per USDT on `to`
        if (buy === undefined || sell === undefined) continue;
        const grossBps = (buy * sell - 1) * 10_000;
        const cost = costBps(rc, size);
        const netBps = grossBps - cost;
        cells.push({
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
  return cells;
}
