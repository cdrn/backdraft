import { erc20Abi, formatEther, formatUnits } from "viem";
import type { Detector, DetectorContext } from "./types.js";

interface TokenInfo {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

// Hardcoded, verified token addresses per chain.
// Sources: Etherscan, Arbiscan, Basescan — verified May 2026.
const TOKENS_BY_CHAIN: Record<string, TokenInfo[]> = {
  ethereum: [
    { symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
    { symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
    { symbol: "WETH", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", decimals: 18 },
    { symbol: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18 },
    { symbol: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8 },
  ],
  arbitrum: [
    { symbol: "USDC", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
    { symbol: "USDT", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
    { symbol: "WETH", address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", decimals: 18 },
    { symbol: "DAI", address: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", decimals: 18 },
    { symbol: "WBTC", address: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", decimals: 8 },
  ],
  base: [
    { symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
    { symbol: "USDT", address: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", decimals: 6 },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    { symbol: "DAI", address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", decimals: 18 },
    { symbol: "WBTC", address: "0x0555e30da8f98308edb960aa94c0db47230d2b9c", decimals: 8 },
  ],
};

export interface TokenBalance {
  symbol: string;
  balance: bigint;
  formatted: string;
  decimals: number;
}

export const valueDetector: Detector = {
  name: "value",
  description: "Checks ETH + blue-chip ERC20 balances on newly deployed contracts",

  async detect(ctx: DetectorContext) {
    const { contract, client } = ctx;
    const tokens = TOKENS_BY_CHAIN[contract.chain];
    if (!tokens) return;

    const balances: TokenBalance[] = [];

    // Check native ETH balance
    const ethBalance = await client.getBalance({ address: contract.address });
    if (ethBalance > 0n) {
      balances.push({
        symbol: "ETH",
        balance: ethBalance,
        formatted: formatEther(ethBalance),
        decimals: 18,
      });
    }

    // Check ERC20 balances in parallel
    const results = await Promise.allSettled(
      tokens.map(async (token) => {
        const balance = await client.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [contract.address],
        });
        return { token, balance };
      })
    );

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { token, balance } = result.value;
      if (balance > 0n) {
        balances.push({
          symbol: token.symbol,
          balance,
          formatted: formatUnits(balance, token.decimals),
          decimals: token.decimals,
        });
      }
    }

    if (balances.length === 0) return;

    // Store balances for downstream use
    ctx.meta.balances = balances.map((b) => ({
      symbol: b.symbol,
      formatted: b.formatted,
    }));
    ctx.tags.add("has-value");

    // Estimate USD value (rough — we don't have price feeds)
    // For scoring purposes: stables = face value, ETH/WETH ~ $3k, WBTC ~ $100k
    const ROUGH_PRICES: Record<string, number> = {
      ETH: 3000, WETH: 3000, WBTC: 100000,
      USDC: 1, USDT: 1, DAI: 1,
    };

    let estimatedUsd = 0;
    for (const b of balances) {
      const price = ROUGH_PRICES[b.symbol] || 0;
      estimatedUsd += parseFloat(b.formatted) * price;
    }

    ctx.meta.estimatedUsd = Math.round(estimatedUsd);

    const severity = estimatedUsd >= 10000 ? "critical"
      : estimatedUsd >= 1000 ? "high"
      : estimatedUsd >= 100 ? "medium"
      : "low";

    const balanceSummary = balances
      .map((b) => `${b.formatted} ${b.symbol}`)
      .join(", ");

    ctx.findings.push({
      detector: "value",
      severity,
      title: `Contract holds value (~$${ctx.meta.estimatedUsd})`,
      description: `Balances: ${balanceSummary}`,
    });
  },
};
