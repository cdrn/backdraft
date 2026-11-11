# Backdraft

## Overview
Cross-venue dislocation seismographs: `delta` (stablecoin cross-chain basis), `funding` (perp funding basis), `spread` (cross-venue realizable spread: CEX↔DEX, same-chain DEX↔DEX, CEX↔CEX). One process (`src/seismograph.ts`), one Docker image, three SQLite DBs, three dashboards (:4747 / :4748 / :4750). Pattern everywhere: poll → store raw → derive net-of-cost board → episodes with hysteresis → paper ledger → Telegram on episode open/close.

The scanner/executor/honeypot-detector that this repo started as is retired (`archive/scanner-2026-11` branch). It was the entire Alchemy bill and had no proven edge. Do not resurrect it on master.

## Tech Stack
- TypeScript (ESM, `moduleResolution: bundler`), viem, better-sqlite3, tsx, node:test
- No paid RPC. Public HTTP RPCs only; on-chain quotes are `eth_call`s. `spread` batches a whole tick into a few chunked Multicall3 calls per chain (`multicallBatchBytes` per chain — Arbitrum's public RPC caps `eth_call` gas at ~10 quoter calls).
- Docker + GitHub Actions → ghcr.io → Watchtower on the VPS

## Conventions
- Never add Co-Authored-By lines on commits or PRs
- Token/venue addresses are hardcoded and must be verified on-chain (symbol + decimals; a quoter by calling it) before landing — a one-digit typo silently drops a whole pair's cells. They must also be EIP-55 checksummed: viem rejects a wrong-case address, cast doesn't, so a cast-verified address can still yield zero quotes
- Spread venue ids: CEX = its name (`coinbase`), DEX = `<chain>/<dex>` (`base/aero`); a route is `<pair> <buy>→<sell>`. Kind is derived from which sides are DEXes. dex→dex is computed same-chain only
- Raw observations are the source of truth; cells/episodes/paper entries are derived and must be rebuildable (`npm run <module>:backfill`). Changing a threshold or cost model = backfill, never hand-edit derived tables
- Cost models are editable tables in `<module>/costs.ts` with pessimal defaults; every knob is env-overridable and documented in `.env.example`
- A paper entry whose route vanished settles as `null` (unfillable), never as a sentinel number that pollutes the mean
- New instruments follow the same shape: `config / venues|quoters / costs / derive / store / collector / server / alerts / main / backfill` + `public/<module>/index.html`
- `npm test` must pass; unit tests cover pure derive math, not network calls

## Gotchas
- Coinbase delisted `*-USDC` products (unified USD/USDC book) — use `ETH-USD`, `BTC-USD`
- Binance.com returns HTTP 451 from US IPs; it's opt-in via `SPREAD_CEX`
- Arbitrum WETH is `0x82aF…fBab1`; Base WETH is the `0x4200…0006` predeploy; both readable from `QuoterV2.WETH9()`
- The spread board is red in calm markets at retail fee tiers. That is the finding, not a bug. Set `SPREAD_TAKER_BPS_*` to the real tier before interpreting it
- Spread pool discovery runs on the first tick (and hourly) and takes ~20s; that one tick overruns the 10s poll by design
- A mid-cap with no cells (DEGEN at $5k) is a pair whose impact exceeds `maxGrossBps`, not a missing pool
- A persistently positive CEX↔DEX route on one pair is a broken bridge, not an arb, until proven otherwise. AERO's Nov 2026 contract migration read as +250 bps for hours because the old contract kept trading on chain while CEXes priced the new one. Check for token migrations / halted deposits before believing a green cell. Likewise `BTC arbitrum/*→okx` going green for days (Nov 2026) was WBTC trading 10–20 bps under BTC — a wrapper basis, not a venue arb (the cbBTC route on Base stayed red)
- The box has 1 GB and no swap. Anything that materialises a window of raw rows or cells in JS (a backfill, a stats endpoint) OOMs it and takes SSH down for minutes. Stream ticks, aggregate in SQLite
- Coinbase `level=2` is the whole aggregated book (~100 KB). Books are trimmed to 2× the largest clip before storing; the raw spread DB hit 15 GB in two days before that. `SPREAD_RETENTION_DAYS` (10) prunes raw + cells hourly; `/api/stats` reads the `cell_hour`/`cell_hist` rollups maintained on insert (a window query over raw cells took 25 min for 7 days)
- `.scratch/` is gitignored; put ad-hoc scripts there (tsx resolves node_modules from the script's directory)

## Deployment
- Push to master → CI (tsc, tests, build) → image → Watchtower restarts `seismograph`
- Secrets in `.env` on the VPS, never in repo
