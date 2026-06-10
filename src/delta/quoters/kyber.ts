import type { EvmChainConfig } from "../config.js";
import type { Quote, Quoter } from "../types.js";

// KyberSwap aggregator: keyless, routes across every venue on the chain
// (Curve, Uniswap, Maverick, …). This is the executable price — what a real
// fill at this size would actually get — unlike a single-pool quote that's
// blind to where the long-tail stablecoin liquidity really lives.

const CHAIN_PATH: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
};

interface KyberRouteResponse {
  code: number;
  message: string;
  data?: { routeSummary?: { amountOut?: string } };
}

export class KyberQuoter implements Quoter {
  chain: string;
  private path: string;

  constructor(private config: EvmChainConfig) {
    this.chain = config.name;
    this.path = CHAIN_PATH[config.name] ?? config.name;
  }

  async quote(
    tokenIn: string,
    tokenOut: string,
    amountUsd: number,
  ): Promise<Quote | null> {
    const inTok = this.config.tokens[tokenIn];
    const outTok = this.config.tokens[tokenOut];
    if (!inTok || !outTok) return null;

    const amountIn = BigInt(
      Math.round(amountUsd * 10 ** inTok.decimals),
    ).toString();
    const url =
      `https://aggregator-api.kyberswap.com/${this.path}/api/v1/routes` +
      `?tokenIn=${inTok.address}&tokenOut=${outTok.address}&amountIn=${amountIn}`;

    // Politeness gap so the per-chain sequential sweep stays under the
    // keyless rate limit.
    await new Promise((r) => setTimeout(r, 600));
    const res = await fetch(url, {
      headers: { "x-client-id": "backdraft-delta" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`kyber ${res.status}`);
    const body = (await res.json()) as KyberRouteResponse;
    const out = body.data?.routeSummary?.amountOut;
    if (!out) return null;

    const amountOut = Number(out) / 10 ** outTok.decimals;
    if (amountOut === 0) return null;
    const price = amountOut / amountUsd;
    return {
      ts: Date.now(),
      chain: this.chain,
      venue: "kyberswap",
      tokenIn,
      tokenOut,
      amountIn: amountUsd,
      amountOut,
      price,
      bps: (price - 1) * 10_000,
    };
  }
}
