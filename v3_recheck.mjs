import { createPublicClient, http, parseAbi, formatEther } from "viem";
import { mainnet, base } from "viem/chains";
import fs from "fs";
import "dotenv/config";

const clients = {
  ethereum: createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")) }),
  base: createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) }),
};
const QUOTERS = {
  ethereum: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  base: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
};
const WETH = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  base: "0x4200000000000000000000000000000000000006",
};

const POOL_ABI = parseAbi([
  "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)"
]);
const QUOTER_ABI = [{
  name: "quoteExactInputSingle", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ]}],
  outputs: [
    { name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" },
  ],
}];

const lines = fs.readFileSync("/Users/cdrn/Code/backdraft/honeypots.txt", "utf8").trim().split("\n");

const results = [];
for (const line of lines) {
  const [pool, chain, symbol] = line.split("|");
  const client = clients[chain];
  const weth = WETH[chain];
  const quoter = QUOTERS[chain];

  try {
    const [t0, t1, fee] = await Promise.all([
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }),
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "fee" }),
    ]);
    const token = t0.toLowerCase() === weth.toLowerCase() ? t1 : t0;

    let buy = "?", sell = "?";
    let buyAmt = 0n;
    try {
      const r = await client.readContract({
        address: quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
        args: [{ tokenIn: weth, tokenOut: token, amountIn: 10n**14n, fee, sqrtPriceLimitX96: 0n }],
      });
      buyAmt = r[0]; buy = "OK";
    } catch { buy = "REVERT"; }

    if (buyAmt > 0n) {
      try {
        await client.readContract({
          address: quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
          args: [{ tokenIn: token, tokenOut: weth, amountIn: buyAmt, fee, sqrtPriceLimitX96: 0n }],
        });
        sell = "OK";
      } catch { sell = "REVERT"; }
    }

    const verdict = (buy === "OK" && sell === "REVERT") ? "REAL_HONEYPOT"
      : (buy === "REVERT" ? "NO_LIQUIDITY"
      : (buy === "OK" && sell === "OK" ? "CLEAN_or_DRAINED" : "UNKNOWN"));

    results.push({ symbol, chain, pool, fee: Number(fee), buy, sell, verdict });
    process.stdout.write(verdict === "REAL_HONEYPOT" ? "!" : verdict === "NO_LIQUIDITY" ? "." : "o");
  } catch (e) {
    results.push({ symbol, chain, pool, verdict: "POOL_BROKEN", err: e.shortMessage?.slice(0,80) });
    process.stdout.write("x");
  }
}

console.log("\n");
const groups = {};
for (const r of results) {
  groups[r.verdict] ||= [];
  groups[r.verdict].push(r);
}

console.log("=== VERDICTS ===");
for (const [v, arr] of Object.entries(groups)) console.log(`  ${v}: ${arr.length}`);

console.log("\n=== REAL HONEYPOTS (buy OK, sell reverts) ===");
for (const r of groups.REAL_HONEYPOT || []) {
  console.log(`  ${r.symbol.padEnd(15)} ${r.chain.padEnd(9)} fee=${r.fee.toString().padStart(5)}  ${r.pool}`);
}

console.log("\n=== NO LIQUIDITY (pool exists but drained/empty) ===");
for (const r of groups.NO_LIQUIDITY || []) {
  console.log(`  ${r.symbol.padEnd(15)} ${r.chain.padEnd(9)} fee=${r.fee.toString().padStart(5)}  ${r.pool}`);
}

console.log("\n=== CLEAN OR DRAINED (both sims work — false positive in detector OR liq drained) ===");
for (const r of groups.CLEAN_or_DRAINED || []) {
  console.log(`  ${r.symbol.padEnd(15)} ${r.chain.padEnd(9)} fee=${r.fee.toString().padStart(5)}  ${r.pool}`);
}

fs.writeFileSync("/Users/cdrn/Code/backdraft/v3_recheck_results.json", JSON.stringify(results, null, 2));
