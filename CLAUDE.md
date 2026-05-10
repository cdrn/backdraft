# Backdraft

## Overview
MEV searcher and contract scanner on Ethereum and Base. Modular pipeline architecture — listeners detect events, detectors analyze them, executor acts on findings. Currently focused on cross-DEX arbitrage on Base.

## Tech Stack
- **Off-chain:** TypeScript, viem, better-sqlite3, tsx
- **On-chain:** Solidity (Foundry), targeting Huff for gas-critical paths later
- **Infra:** Docker, GitHub Actions CI/CD, Watchtower auto-deploy, DigitalOcean VPS

## Architecture
- `src/listener/` — event sources (block watching, factory events, price monitoring)
- `src/detectors/` — two-phase pipeline: cheap prescreen then gated expensive detectors
- `src/executor/` — transaction building and submission, strategy-specific modules
- `src/config/` — feature flags, verified token/DEX addresses per chain
- `src/store/` — SQLite persistence
- `src/alerts/` — Telegram notifications
- `contracts/` — Solidity contracts (Foundry project)

## Key Decisions
- All token/DEX addresses are hardcoded and verified against block explorers — never trust user input or on-chain claims for these
- Feature flags via env vars (ENABLE_*) — no code change needed to toggle modules
- Prescreen detector gates expensive RPC calls — bytecode-only scan first, only hit RPC if interesting selectors found
- Executor defaults to dry-run mode (EXECUTOR_LIVE=false)

## Conventions
- Never add Co-Authored-By lines on commits or PRs
- Blue-chip token addresses must be verified against official block explorers before hardcoding
- New modules follow the listener → detector → executor pattern
- Keep RPC usage minimal — block watching is the dominant cost

## Deployment
- Push to master → CI builds Docker image → Watchtower on VPS pulls and restarts
- VPS runs docker-compose with Watchtower for auto-deploy
- Secrets in `.env` on the VPS, never in repo
- Master killswitch: set `KILLSWITCH=true` in env to halt all activity

## Active Development
- Cross-DEX arbitrage on Base (Uniswap V2/V3, Aerodrome, SushiSwap)
- Solidity arb contract for atomic swaps
