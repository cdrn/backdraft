import { createPublicClient, http, parseAbiItem, formatUnits, formatEther } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")),
});

const TOKEN = "0xb5295b5a763D27feA998E29e90349B9aD42c371E"; // HANTA
const POOL = "0xF6B5a2041643A87244f83C1384C39a17b05a3f3A";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const OWNER = "0x514C52CfD8Db898A95FDCEccBEe6e6556945630E";
const ZERO = "0x0000000000000000000000000000000000000000";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// All HANTA mints (from = address(0))
const mints = await client.getLogs({
  address: TOKEN, event: TRANSFER, args: { from: ZERO },
  fromBlock: 22000000n, toBlock: "latest",
});

console.log("=== HANTA MINT EVENTS ===");
console.log(`Found ${mints.length} mints\n`);
for (const m of mints) {
  console.log(`block ${m.blockNumber} tx ${m.transactionHash}`);
  console.log(`  to: ${m.args.to}`);
  console.log(`  amount: ${formatUnits(m.args.value, 18)} HANTA`);
  console.log("");
}

// HANTA token transfers TO the pool (sells / dumps)
const toPool = await client.getLogs({
  address: TOKEN, event: TRANSFER, args: { to: POOL },
  fromBlock: 22000000n, toBlock: "latest",
});

console.log(`=== HANTA TRANSFERS INTO THE POOL (${toPool.length} total) ===`);
console.log("These are sells OR initial liquidity adds OR dumps\n");
for (const t of toPool) {
  console.log(`block ${t.blockNumber} tx ${t.transactionHash}`);
  console.log(`  from: ${t.args.from}`);
  console.log(`  amount: ${formatUnits(t.args.value, 18)} HANTA`);
  if (t.args.from.toLowerCase() === OWNER.toLowerCase()) console.log("  ⚠️ FROM OWNER");
  console.log("");
}

// WETH OUT of the pool (drain)
const wethOut = await client.getLogs({
  address: WETH, event: TRANSFER, args: { from: POOL },
  fromBlock: 22000000n, toBlock: "latest",
});

console.log(`=== WETH OUT OF POOL (${wethOut.length} total) ===\n`);
for (const t of wethOut) {
  console.log(`block ${t.blockNumber} tx ${t.transactionHash} → ${t.args.to}: ${formatEther(t.args.value)} WETH`);
}
