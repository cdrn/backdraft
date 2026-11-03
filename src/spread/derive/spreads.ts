import { MAX_GROSS_BPS } from "../config.js";
import { clipCost } from "../costs.js";
import type { Book, Cell, DexQuote } from "../types.js";
import { routeKey } from "../types.js";
import { buyFrom, sellInto } from "./book.js";

// Board math. Two directions per (pair, chain, cex, size):
//
//   dex→cex  spend `size` USDC on the DEX for q base units, sell q into the
//            CEX bids. gross = usdOut / size - 1.
//   cex→dex  spend `size` USD walking the CEX asks for q base units, sell q
//            on the DEX for USDC. gross = usdcOut / size - 1.
//
// The DEX sell quote is taken at a reference qty (size / CEX mid at fetch
// time) so every quote for a tick fits in one multicall; we then scale the
// output linearly to the qty the ask-walk actually yields. The error is
// second-order (impact is near-linear over a few bps of qty difference).
//
// Gross is pure price. Costs (CEX fee, gas, rebalance) live in costs.ts and
// are subtracted here so every cell carries the full decomposition.

export function computeCells(
  books: Book[],
  quotes: DexQuote[],
  pairs: { pair: string; cex: Record<string, string> }[],
  sizes: number[],
  ts: number,
): Cell[] {
  const cells: Cell[] = [];
  const q = (chain: string, pair: string, dir: "buy" | "sell", amountIn: number) =>
    quotes.find(
      (x) =>
        x.chain === chain &&
        x.pair === pair &&
        x.dir === dir &&
        Math.abs(x.amountIn - amountIn) <= Math.abs(amountIn) * 1e-9,
    );
  const sellQuotes = (chain: string, pair: string) =>
    quotes.filter((x) => x.chain === chain && x.pair === pair && x.dir === "sell");
  const chains = [...new Set(quotes.map((x) => x.chain))];

  for (const p of pairs) {
    for (const book of books) {
      const sym = p.cex[book.venue];
      if (!sym || book.symbol !== sym) continue;
      for (const chain of chains) {
        for (const size of sizes) {
          const cost = clipCost(chain, book.venue, size);

          // ---- dex→cex ----
          const buy = q(chain, p.pair, "buy", size);
          if (buy) {
            const usdOut = sellInto(book.bids, buy.amountOut);
            if (usdOut !== null) {
              push(cells, {
                ts, pair: p.pair, chain, cex: book.venue, dir: "dex→cex", size,
                dexPx: size / buy.amountOut,
                cexPx: usdOut / buy.amountOut,
                grossBps: (usdOut / size - 1) * 10_000,
                cost,
              });
            }
          }

          // ---- cex→dex ----
          const qty = buyFrom(book.asks, size);
          if (qty !== null) {
            // nearest reference sell quote for this chain/pair by qty
            const sq = sellQuotes(chain, p.pair).reduce<DexQuote | null>(
              (acc, x) =>
                !acc || Math.abs(x.amountIn - qty) < Math.abs(acc.amountIn - qty)
                  ? x
                  : acc,
              null,
            );
            if (sq && sq.amountIn > 0) {
              const usdcOut = sq.amountOut * (qty / sq.amountIn);
              push(cells, {
                ts, pair: p.pair, chain, cex: book.venue, dir: "cex→dex", size,
                dexPx: usdcOut / qty,
                cexPx: size / qty,
                grossBps: (usdcOut / size - 1) * 10_000,
                cost,
              });
            }
          }
        }
      }
    }
  }
  return cells;
}

function push(
  cells: Cell[],
  c: Omit<Cell, "route" | "feeBps" | "gasBps" | "rebalBps" | "costBps" | "netBps" | "netUsd"> & {
    cost: ReturnType<typeof clipCost>;
  },
): void {
  if (!Number.isFinite(c.grossBps) || Math.abs(c.grossBps) > MAX_GROSS_BPS) return;
  const netBps = c.grossBps - c.cost.totalBps;
  const { cost, ...rest } = c;
  cells.push({
    ...rest,
    route: routeKey(c.pair, c.chain, c.cex, c.dir),
    feeBps: cost.feeBps,
    gasBps: cost.gasBps,
    rebalBps: cost.rebalBps,
    costBps: cost.totalBps,
    netBps,
    netUsd: (netBps / 10_000) * c.size,
  });
}

// Best cell per route (by net bps) — the unit the episode detector and paper
// ledger reason about.
export function bestPerRoute(cells: Cell[]): Map<string, Cell> {
  const best = new Map<string, Cell>();
  for (const c of cells) {
    const prev = best.get(c.route);
    if (!prev || c.netBps > prev.netBps) best.set(c.route, c);
  }
  return best;
}
