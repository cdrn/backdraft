# Backdraft

Real-time instrumentation for exploitable on-chain structure on Ethereum, Base, and Arbitrum — and the execution to act on it. Three subsystems share the same plumbing (RPC clients, SQLite persistence, Telegram alerts) but run as independent processes so one can churn without gapping another's dataset:

- **Scanner + executor** — the original MEV searcher. Listeners detect contract deployments and new DEX pools, a two-phase detector pipeline analyzes them (honeypots, proxies, open withdrawals, arb), and the executor acts (claim / snipe / arb). Architecture below.
- **`delta`** — stablecoin venue-basis seismograph (`src/delta/`, own container + DB). Continuously records the *executable* price of swapping stablecoins at size ($1k–$1M) across Ethereum/Base/Arbitrum (UniV3 QuoterV2) and Solana (Jupiter), derives a cross-chain dislocation board and episode catalog net of a rebalance cost model, and paper-trades the result. Dashboard on `:4747`. See `src/delta/`.
- **`funding`** — perp funding-basis seismograph (`src/funding/`, own container + DB). Tracks cross-venue perpetual funding rates and order-book impact to surface carry dislocations, paper-first. Dashboard on `:4748`. See `src/funding/`.

The common thread: watch a market for structure that shouldn't persist — a sell-blocking honeypot, a stablecoin trading off-peg on one chain, a perp paying to hold one side — measure it net of the real cost to act, and only then decide whether it's worth acting on.

## Scanner architecture

```
Listeners                    Pipeline                         Output
─────────────────           ──────────────────────           ──────────
Deployment Listener  ──┐    Prescreen (bytecode, 0 RPC)     SQLite DB
  (watches blocks)     ├──► Proxy Detector          ──────► Telegram
Factory Listener     ──┘    Initializer Detector             Executor
  (DEX pool events)         Open Withdrawal Detector           ├─ Claim
Pool Price Monitor          Ownership Detector                 ├─ Snipe
  (arb opportunities)       Value Detector                     └─ Arb
                            Honeypot Detector
```

### Listeners
- **Deployment listener** — watches blocks for `CREATE` transactions
- **Factory listener** — watches Uniswap V2/V3 factory events for new pools
- **Pool price monitor** — monitors cross-DEX price discrepancies (Base)

### Detectors
Two-phase pipeline. Phase 1 (prescreen) does zero RPC calls — bytecode-only selector scanning. Phase 2 (gated) runs RPC-heavy analysis only if prescreen found something interesting or the contract is a new pool.

### Executor
Dry-run by default. Simulates transactions and logs results. Set `EXECUTOR_LIVE=true` to submit real transactions.

## Setup

```bash
git clone git@github.com:cdrn/backdraft.git
cd backdraft
npm install
cp .env.example .env
# Edit .env with your RPC URLs and config
npm run dev
```

## Feature Flags

All flags default to `true`. Set to `false` in `.env` to disable.

| Flag | What it controls |
|------|-----------------|
| `ENABLE_DEPLOYMENT_LISTENER` | Watch blocks for direct contract deployments |
| `ENABLE_FACTORY_LISTENER` | Watch DEX factory events for new pools |
| `ENABLE_VULN_DETECTORS` | Proxy, initializer, withdrawal, ownership detectors |
| `ENABLE_SNIPER` | Honeypot detection and pool sniping |
| `ENABLE_EXECUTOR` | Transaction execution (dry-run or live) |

### Cost optimization

Block watching is the dominant RPC cost (~97 CU/s across 3 chains). Arbitrum is the most expensive due to fast block times. To reduce costs, drop chains you don't need and disable the deployment listener to rely only on factory events.

## Chain Configuration

Set WebSocket RPC URLs for the chains you want to monitor. Chains without a URL are skipped.

```
ETH_RPC_WS=wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ARB_RPC_WS=wss://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
BASE_RPC_WS=wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

## Deployment

Docker Compose with Watchtower for auto-deploy:

```bash
docker compose up -d
```

Push to master → CI builds image → Watchtower pulls and restarts automatically.

## Project Structure

```
src/
  config/
    flags.ts              Feature flag system
    tokens.ts             Verified token addresses per chain
  listener/
    deployment-listener.ts  Block watching for CREATE txs
    factory-listener.ts     DEX factory event watching
  detectors/
    pipeline.ts           Two-phase detector pipeline
    prescreen-detector.ts Bytecode-only prescreen (0 RPC)
    proxy-detector.ts     EIP-1967/1167 proxy detection
    initializer-detector.ts Uninitialized proxy detection
    open-withdrawal-detector.ts Open withdraw/drain functions
    ownership-detector.ts Zero-owner / claimable ownership
    value-detector.ts     ETH + blue-chip ERC20 balance check
    honeypot-detector.ts  Buy+sell simulation, sniper trap detection
  executor/
    index.ts              Transaction builder and submitter
    strategies/
      snipe.ts            Uniswap V2 swap execution
  store/
    index.ts              SQLite persistence
  alerts/
    telegram.ts           Telegram bot alerts
  index.ts                Entry point (scanner + executor)
  delta/                  Stablecoin venue-basis seismograph (own entry: delta/main.ts)
    collector.ts          Polls executable quotes across chains
    derive/               Spread board, episode detector, paper ledger
    costs.ts              Per-corridor rebalance cost model
    backfill.ts           Replays quote history after threshold/cost changes
  funding/                Perp funding-basis seismograph (own entry: funding/main.ts)
    collector.ts          Polls cross-venue funding + order books
    derive/               Funding dispersion + book-impact models
contracts/                Solidity contracts (Foundry)
```

Run the modules independently: `npm run delta` / `npm run funding` (dev), or `npm run start:delta` / `npm run start:funding` (built). Each keeps its own SQLite DB so the dataset stays continuous.
