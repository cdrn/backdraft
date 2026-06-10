export interface Quote {
  ts: number; // unix ms
  chain: string;
  venue: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number; // USD notional
  amountOut: number;
  price: number; // amountOut / amountIn
  bps: number; // (price - 1) * 10_000
}

export interface Quoter {
  chain: string;
  quote(
    tokenIn: string,
    tokenOut: string,
    amountUsd: number,
  ): Promise<Quote | null>;
}
