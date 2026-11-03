import assert from "node:assert/strict";
import { test } from "node:test";
import { clipCost } from "../costs.js";
import type { Book, DexQuote } from "../types.js";
import { bestPerRoute, computeCells } from "./spreads.js";

const PAIRS = [{ pair: "ETH", cex: { coinbase: "ETH-USDC", okx: "ETH-USDC" } }];
const SIZE = 10_000;

function book(bid: number, ask: number, venue = "coinbase"): Book {
  return {
    ts: 1,
    venue,
    symbol: "ETH-USDC",
    bids: [[bid, 100]],
    asks: [[ask, 100]],
  };
}

function quotes(dexPx: number, refQty: number, dex = "base/uni"): DexQuote[] {
  const chain = dex.slice(0, dex.indexOf("/"));
  return [
    { ts: 1, chain, dex, pair: "ETH", dir: "buy", amountIn: SIZE, amountOut: SIZE / dexPx, feeTier: 500 },
    { ts: 1, chain, dex, pair: "ETH", dir: "sell", amountIn: refQty, amountOut: refQty * dexPx, feeTier: 500 },
  ];
}

test("dex→cex gross is the CEX bid over the DEX buy price", () => {
  // DEX sells ETH at 2000, CEX bids 2010 → gross +50bps
  const cells = computeCells([book(2010, 2011)], quotes(2000, SIZE / 2010), PAIRS, [SIZE], 1);
  const c = cells.find((x) => x.kind === "dex→cex")!;
  assert.ok(Math.abs(c.grossBps - 50) < 1e-6, `gross ${c.grossBps}`);
  assert.equal(c.route, "ETH base/uni→coinbase");
  assert.equal(c.buy, "base/uni");
  assert.equal(c.sell, "coinbase");
  const cost = clipCost("base/uni", "coinbase", SIZE);
  assert.ok(Math.abs(c.netBps - (50 - cost.totalBps)) < 1e-6);
  assert.ok(Math.abs(c.netUsd - (c.netBps / 1e4) * SIZE) < 1e-9);
});

test("cex→dex gross scales the reference sell quote to the walked qty", () => {
  // CEX asks 1990, DEX bids 2000 → gross ≈ +50bps
  const cells = computeCells([book(1989, 1990)], quotes(2000, SIZE / 1989.5), PAIRS, [SIZE], 1);
  const c = cells.find((x) => x.kind === "cex→dex")!;
  assert.ok(Math.abs(c.grossBps - (2000 / 1990 - 1) * 1e4) < 1e-6, `gross ${c.grossBps}`);
  assert.equal(c.route, "ETH coinbase→base/uni");
});

test("dex→dex is same-chain only, atomic: no fee, no rebalance, two swaps of gas", () => {
  const qs = [
    ...quotes(2000, SIZE / 2000, "base/uni"),
    ...quotes(2010, SIZE / 2000, "base/aero"),
    ...quotes(2020, SIZE / 2000, "arbitrum/uni"),
  ];
  const cells = computeCells([book(2005, 2006)], qs, PAIRS, [SIZE], 1);
  const dd = cells.filter((x) => x.kind === "dex→dex");
  assert.deepEqual(
    dd.map((c) => c.route).sort(),
    ["ETH base/aero→base/uni", "ETH base/uni→base/aero"],
    "no cross-chain dex→dex",
  );
  const c = dd.find((x) => x.route === "ETH base/uni→base/aero")!;
  assert.ok(Math.abs(c.grossBps - (2010 / 2000 - 1) * 1e4) < 1e-6, `gross ${c.grossBps}`);
  assert.equal(c.feeBps, 0);
  assert.equal(c.rebalBps, 0);
  const one = clipCost("base/uni", "coinbase", SIZE).gasBps;
  assert.ok(Math.abs(c.gasBps - 2 * one) < 1e-9, "two swaps of gas");
});

test("cex→cex walks asks on one book and bids on the other, pays both fees", () => {
  const cells = computeCells([book(2009, 2010, "coinbase"), book(2015, 2016, "okx")], [], PAIRS, [SIZE], 1);
  const cc = cells.filter((x) => x.kind === "cex→cex");
  assert.equal(cc.length, 2);
  const c = cc.find((x) => x.route === "ETH coinbase→okx")!;
  assert.ok(Math.abs(c.grossBps - (2015 / 2010 - 1) * 1e4) < 1e-6, `gross ${c.grossBps}`);
  assert.equal(c.feeBps, clipCost("coinbase", "okx", SIZE).feeBps);
  assert.ok(c.feeBps > clipCost("base/uni", "okx", SIZE).feeBps, "two CEX fees > one");
  assert.equal(c.gasBps, 0);
});

test("kinds filter drops unwanted routes", () => {
  const cells = computeCells(
    [book(2009, 2010, "coinbase"), book(2015, 2016, "okx")],
    quotes(2000, SIZE / 2010),
    PAIRS,
    [SIZE],
    1,
    ["dex→cex"],
  );
  assert.ok(cells.length > 0);
  assert.ok(cells.every((c) => c.kind === "dex→cex"));
});

test("absurd gross is dropped as a broken quote", () => {
  const cells = computeCells([book(3000, 3001)], quotes(2000, SIZE / 3000), PAIRS, [SIZE], 1);
  assert.equal(cells.filter((x) => x.kind === "dex→cex").length, 0);
});

test("per-pair maxGrossBps widens the sanity bound for thin pairs", () => {
  const wide = [{ ...PAIRS[0], maxGrossBps: 10_000 }];
  const cells = computeCells([book(3000, 3001)], quotes(2000, SIZE / 3000), wide, [SIZE], 1);
  assert.equal(cells.filter((x) => x.kind === "dex→cex").length, 1);
});

test("thin book yields no cell", () => {
  const thin: Book = { ...book(2010, 2011), bids: [[2010, 0.001]] };
  const cells = computeCells([thin], quotes(2000, SIZE / 2010), PAIRS, [SIZE], 1);
  assert.equal(cells.filter((x) => x.kind === "dex→cex").length, 0);
});

test("bestPerRoute picks the highest net per route", () => {
  const cells = computeCells(
    [book(2010, 2011)],
    [...quotes(2000, SIZE / 2010), ...quotes(2005, 5000 / 2010).map((q) => ({ ...q, amountIn: q.dir === "buy" ? 5000 : q.amountIn, amountOut: q.dir === "buy" ? 5000 / 2005 : q.amountOut }))],
    PAIRS,
    [SIZE, 5000],
    1,
  );
  const best = bestPerRoute(cells).get("ETH base/uni→coinbase")!;
  assert.equal(best.size, SIZE);
});
