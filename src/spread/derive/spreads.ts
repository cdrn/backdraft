import { MAX_GROSS_BPS } from "../config.js";
import { clipCost } from "../costs.js";
import type { Book, Cell, DexQuote, Kind } from "../types.js";
import { chainOf, isDexVenue, KINDS, kindOf, routeKey } from "../types.js";
import { buyFrom, sellInto } from "./book.js";

// Board math. For every pair, every ordered (buy venue, sell venue) pair of
// venues that both quote it, at every size:
//
//   buy leg   spend `size` USD on the buy venue for q base units
//             CEX: walk the asks.  DEX: the exact-input buy quote at `size`.
//   sell leg  sell q on the sell venue for USD
//             CEX: walk the bids.  DEX: the reference sell quote (taken at
//             size / CEX mid so every quote for a tick fits in one
//             multicall) scaled linearly to q. The error is second-order
//             (impact is near-linear over a few bps of qty difference).
//
//   gross = usdOut / size - 1
//
// Gross is pure price. Costs (CEX fee, gas, rebalance, tip) live in costs.ts
// and are subtracted here so every cell carries the full decomposition.
// dex→dex is only computed within one chain: cross-chain isn't atomic, it's
// the inventory trade with a bridge in the middle, and we don't model that.

export interface PairLike {
  pair: string;
  cex: Record<string, string>;
  maxGrossBps?: number;
}

export function computeCells(
  books: Book[],
  quotes: DexQuote[],
  pairs: PairLike[],
  sizes: number[],
  ts: number,
  kinds: Kind[] = KINDS,
): Cell[] {
  const cells: Cell[] = [];
  const want = new Set(kinds);

  for (const p of pairs) {
    const maxGross = p.maxGrossBps ?? MAX_GROSS_BPS;
    const pbooks = books.filter((b) => p.cex[b.venue] === b.symbol);
    const pquotes = quotes.filter((x) => x.pair === p.pair);
    const dexes = [...new Set(pquotes.map((x) => x.dex))];
    const venues = [...pbooks.map((b) => b.venue), ...dexes];

    // ---- leg helpers ----
    const buyLeg = (venue: string, size: number): number | null => {
      if (isDexVenue(venue)) {
        const q = pquotes.find(
          (x) => x.dex === venue && x.dir === "buy" && Math.abs(x.amountIn - size) <= size * 1e-9,
        );
        return q && q.amountOut > 0 ? q.amountOut : null;
      }
      const book = pbooks.find((b) => b.venue === venue)!;
      return buyFrom(book.asks, size);
    };
    const sellLeg = (venue: string, qty: number): number | null => {
      if (isDexVenue(venue)) {
        const sq = pquotes
          .filter((x) => x.dex === venue && x.dir === "sell" && x.amountIn > 0)
          .reduce<DexQuote | null>(
            (acc, x) => (!acc || Math.abs(x.amountIn - qty) < Math.abs(acc.amountIn - qty) ? x : acc),
            null,
          );
        return sq ? sq.amountOut * (qty / sq.amountIn) : null;
      }
      const book = pbooks.find((b) => b.venue === venue)!;
      return sellInto(book.bids, qty);
    };

    for (const buy of venues) {
      for (const sell of venues) {
        if (buy === sell) continue;
        const kind = kindOf(buy, sell);
        if (!want.has(kind)) continue;
        if (kind === "dex→dex" && chainOf(buy) !== chainOf(sell)) continue;
        for (const size of sizes) {
          const qty = buyLeg(buy, size);
          if (qty === null || !(qty > 0)) continue;
          const usdOut = sellLeg(sell, qty);
          if (usdOut === null || !(usdOut > 0)) continue;
          const grossBps = (usdOut / size - 1) * 10_000;
          if (!Number.isFinite(grossBps) || Math.abs(grossBps) > maxGross) continue;
          const cost = clipCost(buy, sell, size);
          const netBps = grossBps - cost.totalBps;
          cells.push({
            ts,
            pair: p.pair,
            kind,
            buy,
            sell,
            route: routeKey(p.pair, buy, sell),
            size,
            buyPx: size / qty,
            sellPx: usdOut / qty,
            grossBps,
            feeBps: cost.feeBps,
            gasBps: cost.gasBps,
            rebalBps: cost.rebalBps,
            costBps: cost.totalBps,
            netBps,
            netUsd: (netBps / 10_000) * size,
          });
        }
      }
    }
  }
  return cells;
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
