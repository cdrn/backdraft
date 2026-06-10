import { createPublicClient, http, parseAbi, formatEther } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const WETH = "0x4200000000000000000000000000000000000006";
const GOTCHI_POOL = "0xa82ef0D0e5b54e77732127c237942451D93C2BBc";
const GOTCHI_TOKEN_POOL_QUERY = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);

const [t0, t1, fee] = await Promise.all([
  client.readContract({ address: GOTCHI_POOL, abi: GOTCHI_TOKEN_POOL_QUERY, functionName: "token0" }),
  client.readContract({ address: GOTCHI_POOL, abi: GOTCHI_TOKEN_POOL_QUERY, functionName: "token1" }),
  client.readContract({ address: GOTCHI_POOL, abi: GOTCHI_TOKEN_POOL_QUERY, functionName: "fee" }),
]);
const TOKEN = t0.toLowerCase() === WETH.toLowerCase() ? t1 : t0;
console.log(`GOTCHI token: ${TOKEN}`);
console.log(`Pool fee tier: ${fee}`);

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

console.log("\n--- BUY sim (WETH → GOTCHI, 0.0001 WETH) ---");
try {
  const r = await client.readContract({
    address: QUOTER, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{ tokenIn: WETH, tokenOut: TOKEN, amountIn: 10n**14n, fee, sqrtPriceLimitX96: 0n }],
  });
  console.log(`  ✓ Buy returns: ${r[0]} tokens`);

  console.log("\n--- SELL sim (GOTCHI → WETH, same amount back) ---");
  const s = await client.readContract({
    address: QUOTER, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{ tokenIn: TOKEN, tokenOut: WETH, amountIn: r[0], fee, sqrtPriceLimitX96: 0n }],
  });
  console.log(`  ✓ Sell returns: ${formatEther(s[0])} WETH`);
  const tax = Number((10n**14n - s[0]) * 100n / 10n**14n);
  console.log(`  Round-trip tax: ${tax}%`);
} catch (e) {
  console.log("  ✗ reverted:", e.shortMessage?.slice(0, 200));
}
