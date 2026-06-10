import { createPublicClient, http, parseAbiItem, formatEther } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")),
});

const POOL = "0x4396762E29Ce8D3c2C01a3c427b8851205B761d1";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Pull all WETH transfers in/out of this pool
const transfersIn = await client.getLogs({
  address: WETH,
  event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
  args: { to: POOL },
  fromBlock: 22826000n,
  toBlock: "latest",
});

const transfersOut = await client.getLogs({
  address: WETH,
  event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
  args: { from: POOL },
  fromBlock: 22826000n,
  toBlock: "latest",
});

const totalIn = transfersIn.reduce((a, l) => a + l.args.value, 0n);
const totalOut = transfersOut.reduce((a, l) => a + l.args.value, 0n);

console.log("Pool:", POOL);
console.log("Transfers IN:", transfersIn.length, "Total:", formatEther(totalIn), "ETH");
console.log("Transfers OUT:", transfersOut.length, "Total:", formatEther(totalOut), "ETH");
console.log("Net (in - out):", formatEther(totalIn - totalOut), "ETH");
console.log("\nFirst 5 OUT transfers:");
for (const l of transfersOut.slice(0, 5)) {
  console.log(`  block ${l.blockNumber}: ${formatEther(l.args.value)} ETH to ${l.args.to}`);
}
console.log("\nLast 5 OUT transfers:");
for (const l of transfersOut.slice(-5)) {
  console.log(`  block ${l.blockNumber}: ${formatEther(l.args.value)} ETH to ${l.args.to}`);
}
