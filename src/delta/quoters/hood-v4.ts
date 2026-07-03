import {
  createPublicClient,
  http,
  encodeFunctionData,
  decodeFunctionResult,
  getAddress,
  type PublicClient,
} from "viem";
import { HOOD_CONFIG, type HoodPoolKey } from "../config.js";
import type { Quote, Quoter } from "../types.js";

// On-chain Uniswap v4 quoter for Robinhood Chain. v4 has no per-pool address —
// the singleton PoolManager holds every pool, and a swap is priced by calling
// the periphery V4Quoter with the pool's full PoolKey. quoteExactInputSingle is
// nonpayable-but-eth_call-able (it simulates and returns), so we encode the
// call and read it back. This is the executable single-pool price, which for
// USDG/USDe on Hood is the whole market (liquidity lives in one 0.01% pool).
const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export class HoodV4Quoter implements Quoter {
  chain: string;
  private client: PublicClient;

  constructor() {
    this.chain = HOOD_CONFIG.name;
    this.client = createPublicClient({
      transport: http(HOOD_CONFIG.rpcUrl),
    });
  }

  private poolFor(a: string, b: string): HoodPoolKey | null {
    return HOOD_CONFIG.pools[`${a}/${b}`] ?? HOOD_CONFIG.pools[`${b}/${a}`] ?? null;
  }

  async quote(
    tokenIn: string,
    tokenOut: string,
    amountUsd: number,
  ): Promise<Quote | null> {
    const inTok = HOOD_CONFIG.tokens[tokenIn];
    const outTok = HOOD_CONFIG.tokens[tokenOut];
    const pool = this.poolFor(tokenIn, tokenOut);
    if (!inTok || !outTok || !pool) return null;

    // v4 orders currencies by address; zeroForOne is true when the input token
    // is the lower-addressed currency0.
    const inIsCurrency0 =
      inTok.address.toLowerCase() < outTok.address.toLowerCase();
    const [currency0, currency1] = inIsCurrency0
      ? [inTok.address, outTok.address]
      : [outTok.address, inTok.address];

    const exactAmount = BigInt(Math.round(amountUsd * 10 ** inTok.decimals));
    const data = encodeFunctionData({
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          poolKey: {
            currency0: getAddress(currency0),
            currency1: getAddress(currency1),
            fee: pool.fee,
            tickSpacing: pool.tickSpacing,
            hooks: getAddress(pool.hooks),
          },
          zeroForOne: inIsCurrency0,
          exactAmount,
          hookData: "0x",
        },
      ],
    });

    // eth_call the quoter; a revert (thin/absent pool at this size) → null.
    const res = await this.client.call({
      to: HOOD_CONFIG.v4Quoter,
      data,
    });
    if (!res.data) return null;
    const [amountOutRaw] = decodeFunctionResult({
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      data: res.data,
    });

    const amountOut = Number(amountOutRaw) / 10 ** outTok.decimals;
    if (amountOut === 0) return null;
    const price = amountOut / amountUsd;
    return {
      ts: Date.now(),
      chain: this.chain,
      venue: "uniswap-v4",
      tokenIn,
      tokenOut,
      amountIn: amountUsd,
      amountOut,
      price,
      bps: (price - 1) * 10_000,
    };
  }
}
