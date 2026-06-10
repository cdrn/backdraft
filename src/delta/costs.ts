// Route cost model for one full round-trip rebalance: USDT moves from->to,
// USDC returns to->from (the two transfers run in parallel, so time is the
// max of the two legs, not the sum).
//
// These are conservative editable estimates, not live quotes. The board is
// only as honest as this table — revisit when fees or rails change.

export interface Corridor {
  feeBps: number; // proportional fee on the moved amount
  fixedUsd: number; // fixed fees + gas, all legs
  minutes: number; // expected transfer time
  via: string;
}

const USDC_GAS_USD: Record<string, number> = {
  ethereum: 4,
  base: 0.3,
  arbitrum: 0.3,
  solana: 0.1,
};

// CCTP v2 fast transfer: ~1 bps fee, settles in minutes regardless of
// source-chain finality.
function usdcCorridor(from: string): Corridor {
  return {
    feeBps: 1,
    fixedUsd: USDC_GAS_USD[from] ?? 1,
    minutes: 2,
    via: "cctp-fast",
  };
}

// USDT rails are uneven. Ethereum<->Arbitrum has USDT0 (LayerZero OFT,
// burn-and-mint). Everything else we assume rebalances through a CEX
// (deposit, internal transfer, withdraw) — slower and with withdrawal fees.
function usdtCorridor(from: string, to: string): Corridor {
  const key = [from, to].sort().join("-");
  if (key === "arbitrum-ethereum") {
    return {
      feeBps: 0,
      fixedUsd: from === "ethereum" ? 5 : 1,
      minutes: 5,
      via: "usdt0",
    };
  }
  return { feeBps: 1, fixedUsd: 3, minutes: 30, via: "cex" };
}

export interface RouteCost {
  feeBps: number;
  fixedUsd: number;
  minutes: number;
  via: string;
}

export function routeCost(from: string, to: string): RouteCost {
  const usdt = usdtCorridor(from, to);
  const usdc = usdcCorridor(to);
  return {
    feeBps: usdt.feeBps + usdc.feeBps,
    fixedUsd: usdt.fixedUsd + usdc.fixedUsd,
    minutes: Math.max(usdt.minutes, usdc.minutes),
    via: `${usdt.via}+${usdc.via}`,
  };
}

export function costBps(rc: RouteCost, sizeUsd: number): number {
  return rc.feeBps + (rc.fixedUsd / sizeUsd) * 10_000;
}
