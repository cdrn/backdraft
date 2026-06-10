// Route cost model for one full round-trip rebalance: the quote token moves
// from->to, the base token returns to->from (the two transfers run in
// parallel, so time is the max of the two legs, not the sum).
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

// Per-token rails:
// - USDC: CCTP v2 fast transfer — ~1 bps fee, settles in minutes.
// - USDT: USDT0 (LayerZero OFT burn-and-mint) on Ethereum<->Arbitrum;
//   everywhere else assume CEX rebalance (deposit, transfer, withdraw).
// - USDe: LayerZero OFT burn-and-mint on every chain we track it.
// - Everything else: CEX rebalance.
function corridor(token: string, from: string, to: string): Corridor {
  if (token === "USDC") {
    return {
      feeBps: 1,
      fixedUsd: USDC_GAS_USD[from] ?? 1,
      minutes: 2,
      via: "cctp-fast",
    };
  }
  if (token === "USDT") {
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
  if (token === "USDe") {
    return {
      feeBps: 0,
      fixedUsd: from === "ethereum" ? 5 : 1,
      minutes: 10,
      via: "oft",
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

// Round trip for pair (base, quote): quote token bridges from->to, base
// token returns to->from.
export function routeCost(
  baseToken: string,
  quoteToken: string,
  from: string,
  to: string,
): RouteCost {
  const quoteLeg = corridor(quoteToken, from, to);
  const baseLeg = corridor(baseToken, to, from);
  return {
    feeBps: quoteLeg.feeBps + baseLeg.feeBps,
    fixedUsd: quoteLeg.fixedUsd + baseLeg.fixedUsd,
    minutes: Math.max(quoteLeg.minutes, baseLeg.minutes),
    via: `${quoteLeg.via}+${baseLeg.via}`,
  };
}

export function costBps(rc: RouteCost, sizeUsd: number): number {
  return rc.feeBps + (rc.fixedUsd / sizeUsd) * 10_000;
}
