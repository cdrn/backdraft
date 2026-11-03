# Backdraft

## Overview
Cross-venue dislocation seismographs: `delta` (stablecoin cross-chain basis), `funding` (perp funding basis), `spread` (CEX↔DEX realizable spread). One process (`src/seismograph.ts`), one Docker image, three SQLite DBs, three dashboards (:4747 / :4748 / :4749). Pattern everywhere: poll → store raw → derive net-of-cost board → episodes with hysteresis → paper ledger → Telegram on episode open/close.

The scanner/executor/honeypot-detector that this repo started as is retired (`archive/scanner-2026-11` branch). It was the entire Alchemy bill and had no proven edge. Do not resurrect it on master.

## Tech Stack
- TypeScript (ESM, `moduleResolution: bundler`), viem, better-sqlite3, tsx, node:test
- No paid RPC. Public HTTP RPCs only; on-chain quotes are `eth_call`s. `spread` batches a whole tick into one Multicall3 call per chain.
- Docker + GitHub Actions → ghcr.io → Watchtower on the VPS

## Conventions
- Never add Co-Authored-By lines on commits or PRs
- Token/venue addresses are hardcoded and must be verified on-chain (symbol + decimals) before landing — a one-digit typo silently drops a whole pair's cells
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
- `.scratch/` is gitignored; put ad-hoc scripts there (tsx resolves node_modules from the script's directory)

## Deployment
- Push to master → CI (tsc, tests, build) → image → Watchtower restarts `seismograph`
- Secrets in `.env` on the VPS, never in repo
