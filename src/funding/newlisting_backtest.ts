// Backtest the NEW-LISTING funding-spike thesis on Hyperliquid.
//
// Thesis: a freshly-listed perp sees retail pile in long → funding spikes
// positive → a short collects fat funding for days before arbs arrive. The
// trade is short the new perp + hedge delta (spot or another venue). Here we
// measure the CAPTURABLE side: how much funding a $10k short would have
// collected over the first 72h of each recent listing.
//
// Method: HL fundingHistory returns up to 500 rows ascending from startTime,
// so with a ~20d window an established coin's history starts at the window
// edge while a NEW listing's starts at its listing time → that's our detector.
//
// HONEST LIMITS:
//  • Measures funding COLLECTED on the short only. Ignores the delta hedge's
//    cost/availability (new tokens may have thin/absent spot), the perp's
//    volatility/liquidation risk, and fees. So it's an UPPER bound on edge —
//    if even this is thin/noisy, the thesis is dead; if it's fat, it earns a
//    deeper capturable backtest.
//  • Small sample (only listings within the ~20d API window are visible).

// startTime=0 → HL returns the EARLIEST ~500 funding rows per coin, i.e. its
// history from listing day. So we get the first ~20d of funding for ALL 230
// coins ever listed — the full new-listing sample, not just a recent window.
const HOLD_H = 72;
const NOTIONAL = 10_000;
const HOUR = 3_600_000;
const now = Date.now();

interface Row { time: number; fundingRate: string }

async function meta(): Promise<string[]> {
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "meta" }),
  });
  return ((await r.json()) as { universe: { name: string }[] }).universe.map((u) => u.name);
}

async function funding(coin: string): Promise<Row[]> {
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "fundingHistory", coin, startTime: 0 }),
  });
  if (!r.ok) return [];
  return (await r.json()) as Row[];
}

// simple concurrency pool
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

interface Listing {
  coin: string; listedAgoD: number; rows: number;
  meanAnnPct: number; pctHoursPos: number; carry72hUsd: number; first72hAnn: number;
}

async function main() {
  const coins = await meta();
  console.log(`Scanning ${coins.length} HL perps — first-72h funding from each listing day…\n`);
  const hist = await pool(coins, 8, async (c) => ({ coin: c, rows: await funding(c) }));

  const listings: Listing[] = [];
  for (const { coin, rows } of hist) {
    if (rows.length < 12) continue;
    const firstTs = rows[0].time; // listing day (earliest funding row)
    const first72 = rows.filter((r) => r.time <= firstTs + HOLD_H * HOUR);
    if (first72.length < 12) continue;
    const anns = first72.map((r) => Number(r.fundingRate) * 8760 * 100);
    const mean = anns.reduce((s, x) => s + x, 0) / anns.length;
    const pctPos = anns.filter((x) => x > 0).length / anns.length * 100;
    // carry a $10k SHORT collects over the first 72h (positive funding = short receives)
    const carry = first72.reduce((s, r) => s + NOTIONAL * (Number(r.fundingRate)) , 0);
    listings.push({
      coin, listedAgoD: (now - firstTs) / 86_400_000, rows: rows.length,
      meanAnnPct: mean, pctHoursPos: pctPos, carry72hUsd: carry, first72hAnn: mean,
    });
  }

  listings.sort((a, b) => Math.abs(b.carry72hUsd) - Math.abs(a.carry72hUsd));
  console.log(`Measured first-72h funding for ${listings.length} listings (HL history).\n`);
  console.log(`TOP 15 by |72h carry| (short collects + / pays −):`);
  console.log(`${"coin".padEnd(12)}${"listed".padStart(9)}${"mean ann%".padStart(11)}${"%hrs+".padStart(8)}${"72h carry $".padStart(13)}`);
  for (const l of listings.slice(0, 15)) {
    const ago = l.listedAgoD > 90 ? (l.listedAgoD/30).toFixed(0)+"mo" : l.listedAgoD.toFixed(0)+"d";
    console.log(`${l.coin.padEnd(12)}${ago.padStart(9)}${l.meanAnnPct.toFixed(0).padStart(10)}%${(l.pctHoursPos.toFixed(0)+"%").padStart(8)}${("$"+l.carry72hUsd.toFixed(1)).padStart(13)}`);
  }

  const FEE = 15; // assumed round-trip fill ($10k, blend)
  const abs = listings.map((l) => Math.abs(l.carry72hUsd));
  const total = abs.reduce((s, x) => s + x, 0);
  const clears = listings.filter((l) => Math.abs(l.carry72hUsd) > FEE).length; // tradeable either direction
  const med = [...abs].sort((a, b) => a - b)[Math.floor(abs.length / 2)];
  const meanAbsAnn = listings.reduce((s, l) => s + Math.abs(l.meanAnnPct), 0) / listings.length;
  console.log(`\n=== SIGNAL ===`);
  console.log(`listings: ${listings.length}   mean |funding| first 72h: ${meanAbsAnn.toFixed(0)}% annualized`);
  console.log(`mean |72h carry| per $10k: $${(total/listings.length).toFixed(1)}   median: $${med.toFixed(1)}`);
  console.log(`listings whose |72h carry| > $${FEE} fee (tradeable either side): ${clears}/${listings.length} (${(clears/listings.length*100).toFixed(0)}%)`);

  // recency split — is the spike still there for RECENT listings, or only 2023 inception?
  const bucket = (lbl: string, ls: Listing[]) => {
    if (!ls.length) { console.log(`  ${lbl}: none`); return; }
    const a = ls.map((l) => Math.abs(l.carry72hUsd));
    const cl = ls.filter((l) => Math.abs(l.carry72hUsd) > FEE).length;
    const posDir = ls.filter((l) => l.carry72hUsd > 0).length;
    console.log(`  ${lbl}: ${ls.length} listings  meanAbsCarry=$${(a.reduce((s,x)=>s+x,0)/a.length).toFixed(0)}  clears-fee=${(cl/ls.length*100).toFixed(0)}%  short-collects(+funding)=${(posDir/ls.length*100).toFixed(0)}%`);
  };
  console.log(`\n=== RECENCY SPLIT (capturability: +funding = short+spot, easy; −funding = need to short spot, hard) ===`);
  bucket("< 3 months", listings.filter((l) => l.listedAgoD < 90));
  bucket("3–12 months", listings.filter((l) => l.listedAgoD >= 90 && l.listedAgoD < 365));
  bucket("> 12 months", listings.filter((l) => l.listedAgoD >= 365));
  console.log(`\nNOTE: funding on the perp leg only — IGNORES the delta hedge's cost/availability (a new token's spot may be thin/absent), vol, liquidation, fees. Upper bound on edge. |carry| because some listings fund negative (short pays); the capturable trade picks the right side.`);
}

main();
