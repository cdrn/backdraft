# Backdraft

Cross-venue dislocation seismographs. Three instruments share one process, one image and one pattern — **poll keyless public endpoints, record the executable price, subtract the real cost to act, paper-trade the residual, and only then decide whether it's worth acting on**:

| module | question | sources | port |
|---|---|---|---|
| **`delta`** | Is the same dollar-stablecoin cheaper on one chain than another, net of bridging? | KyberSwap (ETH/Base/Arb), Jupiter (Solana), Uniswap v4 (Robinhood Chain) | `:4747` |
| **`funding`** | Is one perp venue paying to hold a side the others aren't, net of fees and book impact? | Hyperliquid, dYdX, OKX, Paradex, Arcus | `:4748` |
| **`spread`** | Is the spread between any two venues on the same asset positive after exchange fee, gas and impact — and does it survive landing late? CEX↔DEX, same-chain DEX↔DEX (atomic), CEX↔CEX | Coinbase, OKX, (Binance); Uniswap V3/V4, Aerodrome, PancakeSwap on Base; Uniswap V3/V4, Camelot, PancakeSwap, Sushi on Arbitrum | `:4750` |

Nothing here costs money to run. Every data source is a keyless public endpoint and every on-chain quote is an `eth_call` against a public RPC — the spread module packs an entire tick's quotes into a handful of Multicall3 calls per chain.

The original contract-deployment scanner / MEV executor that this repo started as is retired. It burned ~97 CU/s of Alchemy watching three chains' blocks, and the 34-hour forensic pass found zero cross-DEX spreads above 5 bps and one real honeypot with ~$395 of victim inflow. Its code lives on the `archive/scanner-2026-11` branch.

## spread — cross-venue realizable spread

The instrument built for the "can I get a foot in the CEX-DEX arb game" question. It does not try to be fast. It measures, at a 10-second cadence, what a non-colocated operator with a given exchange fee tier could actually have captured — and, for the atomic same-chain routes, what the searchers are already taking.

Every tick, per pair × clip size ($5k / $25k / $100k) × every ordered pair of venues that both quote it:

```
buy leg    spend $size on the buy venue for q units
             CEX: walk the asks      DEX: exact-input quote through the deepest pool
sell leg   sell q on the sell venue
             CEX: walk the bids      DEX: reference sell quote scaled to q

gross  = usd_out / usd_in − 1            (pool fee + both legs' impact already inside)
cost   = Σ CEX fees + Σ gas / size + rebalance / clips / size   (+ builder tip for atomic)
net    = gross − cost

kinds      dex→cex, cex→dex   the inventory trade
           dex→dex            same chain only; atomic, no inventory, no rebalance
           cex→cex            two books; a control for where the edge lives
```

Pairs: ETH, BTC (cbBTC / WBTC) on both chains; AERO, VIRTUAL, DEGEN on Base; ARB, LINK, PENDLE, UNI on Arbitrum. Mid-caps are where retail CEX↔DEX arb actually happens — thin pools, lagging books — so they're also where a $5k clip's impact is the whole story. A pair with no pool on a DEX just has no cells there; DEGEN at $5k blows through the sanity bound on every pool, which is its answer. Narrow with `SPREAD_PAIRS`, `SPREAD_DEXES`, `SPREAD_KINDS`.

Pools are discovered at startup and hourly: every (DEX, pair, fee tier) is probed at the smallest and largest clip and only the best tier at each end is quoted per tick, so a tick is ~250 quotes in ~10 chunked `eth_call`s per chain, well inside what the public RPCs tolerate.

Then three derived views, all rebuildable from the raw books and quotes with `npm run spread:backfill`:

- **Board / route stats** — share of ticks a route is net-positive, p50 / p90 / max, current value.
- **Episodes** — a route "opens" above `SPREAD_EPISODE_OPEN_BPS` and closes with hysteresis; duration tells you whether the window is yours (seconds → bots; minutes → you).
- **Paper ledger** — when a route clears the threshold, record what the quote promised, re-price the same clip `SPREAD_LATENCY_MS` later, record what you'd have netted. The mean gap is your **latency tax**. Entries whose route vanished before the latency elapsed settle as *unfillable*, not as a fake number.

**The fee tier is the whole game.** Defaults are pessimal retail tiers (Coinbase 40 bps taker, OKX 10). At those numbers the board is red in calm markets — a 5 bps pool fee each side plus 10–40 bps of exchange fee is more than the spread. The firms that run this pay 0–2 bps. Set `SPREAD_TAKER_BPS_*` to your real tier before reading the board as anything other than "what tier would I need". `SPREAD_CEX_EXEC=maker` models resting orders instead (maker fee + adverse-selection haircut, no book impact).

Known simplifications, in order of how much they matter:
1. Both legs are REST-polled, so they're a few hundred ms apart. Fine for a distribution study at 10s; wrong for execution. For dex→dex this matters most: a 10s sample sees the *residual* after the searchers have already closed the block-level gap, so a persistently positive dex→dex route is either real or a pool nobody routes through — check which before believing it.
2. BTC on-chain is cbBTC (Base) / WBTC (Arbitrum) against spot BTC on the CEX — the wrapper basis is inside the "spread". ETH is the clean pair.
3. The DEX sell quote is taken at `size / CEX mid` and scaled linearly to the qty the buy leg yields (second-order error).
4. dex→dex is single-hop through the best pool on each side; a real bundle would route (multi-hop, split) and do better, and pays a builder tip we default to zero (`SPREAD_ATOMIC_TIP_BPS`).
5. Inventory carry and your own impact on the next tick are not modelled.

## Setup

```bash
git clone git@github.com:cdrn/backdraft.git && cd backdraft
npm install
cp .env.example .env     # everything optional; defaults are public endpoints
npm run dev              # all three modules, tsx watch
```

Per module: `npm run spread` / `npm run delta` / `npm run funding` (dev) or `npm run start:<module>` (built). `ENABLE_DELTA|FUNDING|SPREAD=false` drops one from the combined process. Each module keeps its own SQLite DB.

```bash
npm test                 # node:test via tsx — book walk and spread math
npm run build            # tsc → dist/
```

## Deployment

```bash
docker compose up -d     # seismograph container (3 ports on localhost) + watchtower
```

Push to master → CI typechecks, tests, builds the image → Watchtower pulls and restarts.

## Project structure

```
src/
  seismograph.ts         combined entry (delta + funding + spread)
  delta/                 stablecoin cross-chain basis
    collector.ts         polls executable quotes across chains
    quoters/             kyber (EVM), jupiter (Solana), hood-v4 (Robinhood Chain)
    derive/              spread board, episode detector, paper ledger
    costs.ts             per-corridor bridge/rebalance cost model
    mm/dryrun.ts         inventory market-maker decision loop, dry-run
    backfill.ts          replay raw quotes after threshold/cost changes
  funding/               perp funding basis
    venues/              hyperliquid, dydx, okx, paradex, arcus
    derive/              dispersion, book impact, execution model, paper ledger
    backtest.ts          historical verdict on cross-venue carry
  spread/                CEX↔DEX realizable spread
    config.ts            pairs, chains, sizes, fee tiers (all env-tunable)
    venues/              coinbase, okx, binance (REST books)
    quoters/univ3.ts     QuoterV2 via one Multicall3 call per chain
    costs.ts             CEX fee + gas + rebalance per clip
    derive/              book walk, cell math, episodes, paper ledger, route stats
    store.ts             raw books + quotes (source of truth), derived cells
    backfill.ts          rebuild cells/episodes/paper from raw
public/<module>/         dashboards, served by each module's HTTP server
```
