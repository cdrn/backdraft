import assert from "node:assert/strict";
import { test } from "node:test";
import { clipCost } from "../costs.js";
import type { Book, DexQuote } from "../types.js";
import { bestPerRoute, computeCells } from "./spreads.js";

const PAIRS = [{ pair: "ETH", cex: { coinbase: "ETH-USDC" } }];
const SIZE = 10_000;

function book(bid: number, ask: number): Book {
  return {
    ts: 1,
    venue: "coinbase",
    symbol: "ETH-USDC",
    bids: [[bid, 100]],
    asks: [[ask, 100]],
  };
}

function quotes(dexPx: number, refQty: number): DexQuote[] {
  return [
    { ts: 1, chain: "base", pair: "ETH", dir: "buy", amountIn: SIZE, amountOut: SIZE / dexPx, feeTier: 500 },
    { ts: 1, chain: "base", pair: "ETH", dir: "sell", amountIn: refQty, amountOut: refQty * dexPx, feeTier: 500 },
  ];
}

test("dex→cex gross is the CEX bid over the DEX buy price", () => {
  // DEX sells ETH at 2000, CEX bids 2010 → gross +50bps
  const cells = computeCells([book(2010, 2011)], quotes(2000, SIZE / 2010), PAIRS, [SIZE], 1);
  const c = cells.find((x) => x.dir === "dex→cex")!;
  assert.ok(Math.abs(c.grossBps - 50) < 1e-6, `gross ${c.grossBps}`);
  assert.equal(c.route, "ETH base→coinbase");
  const cost = clipCost("base", "coinbase", SIZE);
  assert.ok(Math.abs(c.netBps - (50 - cost.totalBps)) < 1e-6);
  assert.ok(Math.abs(c.netUsd - (c.netBps / 1e4) * SIZE) < 1e-9);
});

test("cex→dex gross scales the reference sell quote to the walked qty", () => {
  // CEX asks 1990, DEX bids 2000 → gross ≈ +50bps
  const cells = computeCells([book(1989, 1990)], quotes(2000, SIZE / 1989.5), PAIRS, [SIZE], 1);
  const c = cells.find((x) => x.dir === "cex→dex")!;
  assert.ok(Math.abs(c.grossBps - (2000 / 1990 - 1) * 1e4) < 1e-6, `gross ${c.grossBps}`);
  assert.equal(c.route, "ETH coinbase→base");
});

test("absurd gross is dropped as a broken quote", () => {
  const cells = computeCells([book(3000, 3001)], quotes(2000, SIZE / 3000), PAIRS, [SIZE], 1);
  assert.equal(cells.filter((x) => x.dir === "dex→cex").length, 0);
});

test("thin book yields no cell", () => {
  const thin: Book = { ...book(2010, 2011), bids: [[2010, 0.001]] };
  const cells = computeCells([thin], quotes(2000, SIZE / 2010), PAIRS, [SIZE], 1);
  assert.equal(cells.filter((x) => x.dir === "dex→cex").length, 0);
});

test("bestPerRoute picks the highest net per route", () => {
  const cells = computeCells(
    [book(2010, 2011)],
    [...quotes(2000, SIZE / 2010), ...quotes(2005, 5000 / 2010).map((q) => ({ ...q, amountIn: q.dir === "buy" ? 5000 : q.amountIn, amountOut: q.dir === "buy" ? 5000 / 2005 : q.amountOut }))],
    PAIRS,
    [SIZE, 5000],
    1,
  );
  const best = bestPerRoute(cells).get("ETH base→coinbase")!;
  assert.equal(best.size, SIZE);
});
