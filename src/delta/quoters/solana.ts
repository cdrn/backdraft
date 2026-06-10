import { JUPITER_QUOTE_URL, SOLANA_TOKENS } from "../config.js";
import type { Quote, Quoter } from "../types.js";

interface JupiterQuoteResponse {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
}

export class JupiterQuoter implements Quoter {
  chain = "solana";

  async quote(
    tokenIn: string,
    tokenOut: string,
    amountUsd: number,
  ): Promise<Quote | null> {
    const inTok = SOLANA_TOKENS[tokenIn];
    const outTok = SOLANA_TOKENS[tokenOut];
    if (!inTok || !outTok) return null;

    const amount = BigInt(Math.round(amountUsd * 10 ** inTok.decimals));
    const url = new URL(JUPITER_QUOTE_URL);
    url.searchParams.set("inputMint", inTok.mint);
    url.searchParams.set("outputMint", outTok.mint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("slippageBps", "100");

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`jupiter ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as JupiterQuoteResponse;
    const amountOut = Number(data.outAmount) / 10 ** outTok.decimals;
    if (amountOut === 0) return null;
    const price = amountOut / amountUsd;
    return {
      ts: Date.now(),
      chain: this.chain,
      venue: "jupiter",
      tokenIn,
      tokenOut,
      amountIn: amountUsd,
      amountOut,
      price,
      bps: (price - 1) * 10_000,
    };
  }
}
