// Delta MM v0 — PHASE 0 (dry-run). No keys, no capital, no signing.
//
// Runs the full market-maker decision loop against the LIVE Kyber basis and
// logs what it WOULD do: clip when the net edge clears threshold, deplete
// simulated inventory, rebalance (in bulk) when a fuel leg runs low. After
// every clip it samples the basis for 5 min to measure how fast the spread
// reloads — the one number the historical data can't give us (true capacity).
//
// COST MODEL (the important bit): the per-clip cost is ~gas only, because the
// two swaps' fees + impact are already inside the Kyber quote. The bridge
// FIXED cost is NOT per-clip — it's paid once per bulk rebalance and amortized
// across all the clips since the last one. So we track two running tallies:
// clip profit vs rebalance drag. (The stock costBps() bakes the fixed cost into
// every trip — correct for bridge-through, wrong for an inventory book.)
//
// Route: buy USDT cheap on Base, sell on the exit chain. Ethereum excluded by
// default (per-swap gas ~$2-10 kills a small clip); Arbitrum/Solana only.
//
//   MM_EXIT_CHAIN=arbitrum MM_CLIP_USD=2000 npx tsx src/delta/mm/dryrun.ts
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { EVM_CHAINS } from "../config.js";
import { routeCost, type RouteCost } from "../costs.js";
import { KyberQuoter } from "../quoters/kyber.js";

// ---- knobs (env-overridable) ----
const EXIT_CHAIN = process.env.MM_EXIT_CHAIN ?? "arbitrum"; // NOT ethereum (gas)
const CLIP_USD = Number(process.env.MM_CLIP_USD ?? 2_000);
const GAS_BPS = Number(process.env.MM_GAS_BPS ?? 0.5); // per-clip gas (~$0.02 arb → <0.1bps @ $2k; 0.5 is conservative)
const THRESHOLD_BPS = Number(process.env.MM_THRESHOLD_BPS ?? 5); // net edge to fire
const PERSIST_TICKS = Number(process.env.MM_PERSIST_TICKS ?? 2); // anti-noise gate
const POLL_MS = Number(process.env.MM_POLL_MS ?? 15_000);
const SUSPICIOUS_BPS = Number(process.env.MM_SUSPICIOUS_BPS ?? 40); // depeg/glitch halt
const RELOAD_SECS = Number(process.env.MM_RELOAD_SECS ?? 300); // sample window after a clip
const LOG_DIR = process.env.MM_LOG_DIR ?? "mm-logs";
const DECISIONS = `${LOG_DIR}/decisions.csv`;
const RELOAD = `${LOG_DIR}/reload.csv`;

// ---- simulated inventory (dry-run) — weighted toward the fuel each leg burns:
// buy USDT on Base burns Base-USDC; sell USDT on exit burns exit-USDT ----
const inv = { baseUSDC: 4_000, baseUSDT: 1_000, exitUSDC: 1_000, exitUSDT: 4_000 };
const START = { ...inv };

const base = new KyberQuoter(EVM_CHAINS.find((c) => c.name === "base")!);
const exit = new KyberQuoter(EVM_CHAINS.find((c) => c.name === EXIT_CHAIN)!);
const rc: RouteCost = routeCost("USDC", "USDT", "base", EXIT_CHAIN);

// running P&L (dry-run): clip edge captured vs rebalance drag paid
const pnl = { clips: 0, rebalances: 0, clipUsd: 0, rebalUsd: 0 };

function ensureLogs() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  if (!existsSync(DECISIONS))
    writeFileSync(DECISIONS, "ts,route,clipUsd,grossBps,netBps,decision,reason,cumClipUsd,cumRebalUsd,cumNetUsd,baseUSDC,exitUSDT\n");
  if (!existsSync(RELOAD)) writeFileSync(RELOAD, "clipId,offsetSec,netBps\n");
}

// one basis read → gross + net (net = gross − per-clip gas; swap fees are in the quote)
async function readNet(): Promise<{ gross: number; net: number } | null> {
  const buy = await base.quote("USDC", "USDT", CLIP_USD);
  const sell = await exit.quote("USDT", "USDC", CLIP_USD);
  if (!buy || !sell) return null;
  const gross = (buy.price * sell.price - 1) * 10_000;
  return { gross, net: gross - GAS_BPS };
}

async function sampleReload(clipId: number): Promise<void> {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < RELOAD_SECS) {
    const r = await readNet();
    if (r) appendFileSync(RELOAD, `${clipId},${Math.round((Date.now() - t0) / 1000)},${r.net.toFixed(3)}\n`);
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}

let streak = 0;
let clipId = 0;
let reloadActive = false;

async function tick(): Promise<void> {
  const now = new Date().toISOString();
  const r = await readNet();
  const netUsd = pnl.clipUsd - pnl.rebalUsd;
  const log = (decision: string, reason: string, gross = "", net = "") =>
    appendFileSync(
      DECISIONS,
      `${now},base→${EXIT_CHAIN},${CLIP_USD},${gross},${net},${decision},${reason},` +
        `${pnl.clipUsd.toFixed(2)},${pnl.rebalUsd.toFixed(2)},${netUsd.toFixed(2)},` +
        `${inv.baseUSDC.toFixed(0)},${inv.exitUSDT.toFixed(0)}\n`,
    );

  if (!r) { log("skip", "no-quote"); streak = 0; return; }
  const g = r.gross.toFixed(2), n = r.net.toFixed(2);

  // depeg / glitch guard — real edge is ~12bps; a huge print means a leg is off-peg
  if (Math.abs(r.gross) > SUSPICIOUS_BPS) { log("halt", "suspicious-spread", g, n); streak = 0; return; }

  streak = r.net > THRESHOLD_BPS ? streak + 1 : 0;

  // rebalance first — if a fuel leg can't cover a clip, bulk-rebalance back to start.
  // cost = fixed (once) + feeBps × amount actually moved (both legs).
  if (inv.baseUSDC < CLIP_USD || inv.exitUSDT < CLIP_USD) {
    const moved = (START.baseUSDC - inv.baseUSDC) + (START.exitUSDT - inv.exitUSDT);
    const cost = rc.fixedUsd + (rc.feeBps / 10_000) * moved;
    pnl.rebalances++; pnl.rebalUsd += cost;
    Object.assign(inv, START);
    log("rebalance", `moved $${moved.toFixed(0)} · cost $${cost.toFixed(2)} (${rc.via},${rc.minutes}min)`, g, n);
    return;
  }

  if (streak >= PERSIST_TICKS) {
    clipId++;
    const gain = (r.net / 1e4) * CLIP_USD;
    inv.baseUSDC -= CLIP_USD; inv.baseUSDT += CLIP_USD;
    inv.exitUSDT -= CLIP_USD; inv.exitUSDC += CLIP_USD;
    pnl.clips++; pnl.clipUsd += gain;
    log("clip", `id=${clipId} +${n}bps ($${gain.toFixed(2)})`, g, n);
    streak = 0;
    if (!reloadActive) { reloadActive = true; void sampleReload(clipId).finally(() => (reloadActive = false)); }
  } else {
    log("skip", r.net > THRESHOLD_BPS ? `building(${streak}/${PERSIST_TICKS})` : "below-threshold", g, n);
  }
}

async function main(): Promise<void> {
  ensureLogs();
  console.log(
    `[mm-dryrun] base→${EXIT_CHAIN} · clip $${CLIP_USD} · fire net>${THRESHOLD_BPS}bps×${PERSIST_TICKS} · poll ${POLL_MS / 1000}s\n` +
      `  per-clip cost = gas ~${GAS_BPS}bps (swap fees are in the quote); rebalance = $${rc.fixedUsd} fixed + ${rc.feeBps}bps × moved, amortized (${rc.via})\n` +
      `  DRY RUN — no keys, no signing, no capital. logs → ${LOG_DIR}/`,
  );
  const maxTicks = Number(process.env.MM_MAX_TICKS ?? 0); // 0 = run forever
  for (let i = 0; !maxTicks || i < maxTicks; i++) {
    try { await tick(); } catch (e) { console.error(`[mm] tick: ${e instanceof Error ? e.message : e}`); }
    if (maxTicks && i + 1 >= maxTicks) break;
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  const netUsd = pnl.clipUsd - pnl.rebalUsd;
  console.log(`[mm-dryrun] done. clips ${pnl.clips} (+$${pnl.clipUsd.toFixed(2)}) · rebalances ${pnl.rebalances} (−$${pnl.rebalUsd.toFixed(2)}) · NET $${netUsd.toFixed(2)}`);
}

void main();
