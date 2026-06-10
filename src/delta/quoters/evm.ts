import { createPublicClient, http, parseUnits, type PublicClient } from "viem";
import type { EvmChainConfig } from "../config.js";
import type { Quote, Quoter } from "../types.js";

const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export class UniV3Quoter implements Quoter {
  chain: string;
  private client: PublicClient;
  // Cache the working fee tier per pair so we don't probe every tick.
  private feeCache = new Map<string, number>();

  constructor(private config: EvmChainConfig) {
    this.chain = config.name;
    this.client = createPublicClient({ transport: http(config.rpcUrl) });
  }

  async quote(
    tokenIn: string,
    tokenOut: string,
    amountUsd: number,
  ): Promise<Quote | null> {
    const inTok = this.config.tokens[tokenIn];
    const outTok = this.config.tokens[tokenOut];
    if (!inTok || !outTok) return null;

    const amountIn = parseUnits(String(amountUsd), inTok.decimals);
    const cacheKey = `${tokenIn}/${tokenOut}`;
    const cached = this.feeCache.get(cacheKey);
    const tiers = cached
      ? [cached, ...this.config.feeTiers.filter((f) => f !== cached)]
      : this.config.feeTiers;

    for (const fee of tiers) {
      try {
        const { result } = await this.client.simulateContract({
          address: this.config.quoterV2,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: inTok.address,
              tokenOut: outTok.address,
              amountIn,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
        const amountOut = Number(result[0]) / 10 ** outTok.decimals;
        if (amountOut === 0) continue;
        this.feeCache.set(cacheKey, fee);
        const price = amountOut / amountUsd;
        return {
          ts: Date.now(),
          chain: this.chain,
          venue: `univ3-${fee}`,
          tokenIn,
          tokenOut,
          amountIn: amountUsd,
          amountOut,
          price,
          bps: (price - 1) * 10_000,
        };
      } catch {
        continue; // pool missing or quote reverted at this tier
      }
    }
    return null;
  }
}
