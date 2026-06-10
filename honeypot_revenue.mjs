import { createPublicClient, http, parseAbi, parseAbiItem, formatEther, formatUnits } from "viem";
import { mainnet, base } from "viem/chains";
import fs from "fs";
import "dotenv/config";

const ethRpc = process.env.ETH_RPC_WS.replace("wss://", "https://");
const baseRpc = process.env.BASE_RPC_WS.replace("wss://", "https://");

const clients = {
  ethereum: createPublicClient({ chain: mainnet, transport: http(ethRpc) }),
  base: createPublicClient({ chain: base, transport: http(baseRpc) }),
};

const WETH_BY_CHAIN = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  base: "0x4200000000000000000000000000000000000006",
};

const EXPLORER = {
  ethereum: "https://etherscan.io",
  base: "https://basescan.org",
};

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const lines = fs.readFileSync("/tmp/honeypots.txt", "utf8").trim().split("\n");

console.log("Querying", lines.length, "honeypot pools...\n");

const results = [];
let totalRevenueEth = 0n;
let totalCurrentEth = 0n;

for (const line of lines) {
  const [pool, chain, symbol, deployBlock] = line.split("|");
  const client = clients[chain];
  const weth = WETH_BY_CHAIN[chain];

  try {
    // Current WETH balance (what's still in the pool)
    const currentBal = await client.readContract({
      address: weth,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [pool],
    });

    // All WETH transfers OUT of the pool since deployment.
    // In a honeypot, victims can't sell, so the only way WETH leaves is the
    // operator draining. Sum = operator's gross capture.
    const fromBlock = BigInt(deployBlock || 0);
    const logs = await client.getLogs({
      address: weth,
      event: TRANSFER_EVENT,
      args: { from: pool },
      fromBlock,
      toBlock: "latest",
    });

    const drainedOut = logs.reduce((acc, l) => acc + l.args.value, 0n);

    totalRevenueEth += drainedOut;
    totalCurrentEth += currentBal;

    results.push({
      chain,
      symbol,
      pool,
      drained: formatEther(drainedOut),
      current: formatEther(currentBal),
      url: `${EXPLORER[chain]}/address/${pool}`,
    });

    process.stdout.write(".");
  } catch (err) {
    results.push({ chain, symbol, pool, error: err.message.slice(0, 80) });
    process.stdout.write("x");
  }
}

console.log("\n\n=== HONEYPOT REVENUE ===\n");
console.log(`Total drained: ${formatEther(totalRevenueEth)} ETH`);
console.log(`Still in pools: ${formatEther(totalCurrentEth)} ETH`);
console.log(`Combined (gross): ${formatEther(totalRevenueEth + totalCurrentEth)} ETH\n`);

const sorted = results
  .filter(r => !r.error)
  .sort((a, b) => parseFloat(b.drained) - parseFloat(a.drained));

console.log("Top earners:\n");
for (const r of sorted.slice(0, 20)) {
  console.log(`${r.symbol.padEnd(15)} ${r.chain.padEnd(10)} drained=${r.drained.padStart(20)} current=${r.current.padStart(20)}  ${r.url}`);
}

const errors = results.filter(r => r.error);
if (errors.length > 0) {
  console.log("\nErrors:", errors.length);
  for (const e of errors.slice(0, 5)) console.log(" ", e.symbol, e.error);
}

fs.writeFileSync("/tmp/honeypot_results.json", JSON.stringify(results, null, 2));
