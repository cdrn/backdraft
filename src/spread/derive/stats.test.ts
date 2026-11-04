import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../store.js";
import type { Cell } from "../types.js";
import { routeStats } from "./stats.js";

function cell(ts: number, route: string, netBps: number): Cell {
  return {
    ts, pair: "ETH", kind: "dex→dex", buy: "base/pcs", sell: "base/uni", route, size: 5000,
    buyPx: 1, sellPx: 1, grossBps: netBps, feeBps: 0, gasBps: 0, rebalBps: 0, costBps: 0, netBps,
    netUsd: (netBps / 1e4) * 5000,
  };
}

test("routeStats aggregates in SQL and matches the sorted-array quantiles", () => {
  const store = new Store(":memory:");
  const nets = [-9, -3, 4, -1, 7, -6, 2, 0, -2, 5]; // 10 ticks
  const now = Date.now();
  nets.forEach((n, i) => store.insertTick([], [], [cell(now - (nets.length - i) * 10_000, "ETH base/pcs→base/uni", n), cell(now - (nets.length - i) * 10_000, "ETH base/uni→base/pcs", -n - 1)]));
  const s = routeStats(store, 1, 5000).find((r) => r.route === "ETH base/pcs→base/uni")!;
  const sorted = [...nets].sort((a, b) => a - b);
  assert.equal(s.ticks, 10);
  assert.equal(s.positiveShare, 0.4);
  assert.equal(s.p50Bps, sorted[Math.floor(0.5 * 10)]);
  assert.equal(s.p90Bps, sorted[Math.floor(0.9 * 10)]);
  assert.equal(s.maxBps, 7);
  assert.equal(s.currentNetBps, 5);
  assert.equal(s.pair, "ETH");
  assert.equal(s.kind, "dex→dex");
});
