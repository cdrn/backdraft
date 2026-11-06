import assert from "node:assert/strict";
import { test } from "node:test";
import { buyFrom, mid, sellInto, trimLevels } from "./book.js";

test("sellInto walks bids and returns null when thin", () => {
  const bids: [number, number][] = [[100, 1], [99, 2]];
  assert.equal(sellInto(bids, 0.5), 50);
  assert.equal(sellInto(bids, 2), 100 + 99);
  assert.equal(sellInto(bids, 3), 100 + 198);
  assert.equal(sellInto(bids, 3.1), null);
});

test("buyFrom walks asks by USD", () => {
  const asks: [number, number][] = [[100, 1], [101, 1]];
  assert.equal(buyFrom(asks, 50), 0.5);
  assert.equal(buyFrom(asks, 100), 1);
  assert.ok(Math.abs(buyFrom(asks, 201)! - 2) < 1e-12);
  assert.equal(buyFrom(asks, 202), null);
});

test("mid", () => {
  assert.equal(mid([[99, 1]], [[101, 1]]), 100);
  assert.equal(mid([], [[101, 1]]), null);
});

test("trimLevels keeps the depth a clip can walk and at least minLevels", () => {
  const deep = Array.from({ length: 500 }, () => [100, 10] as [number, number]); // $1k per level
  const t = trimLevels(deep, 50_000, 20);
  assert.equal(t.length, 50); // 50 levels x ~$1k crosses the cap
  assert.equal(trimLevels(deep, 100, 20).length, 20);
  assert.equal(trimLevels(deep.slice(0, 5), 50_000, 20).length, 5); // thin book untouched
  assert.equal(buyFrom(trimLevels(deep, 50_000), 25_000), buyFrom(deep, 25_000)); // walk unchanged under the cap
});
