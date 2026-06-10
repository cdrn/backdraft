import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const TOKEN = "0x0E27FB491Ce7208cB110a482ACfB92405E23cf3C"; // Xvt
const OWNER = "0x91508018F75F93AF3C8C7C501757f1Db57f19804";
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// All Xvt token transfers
const logs = await client.getLogs({ address: TOKEN, event: TRANSFER, fromBlock: 33000000n, toBlock: "latest" });
console.log(`${logs.length} transfer events for Xvt\n`);

// Group by 'from' address — anyone who's been a successful sender at least once is whitelisted (or the trap is conditional)
const sendersOk = new Map();
for (const l of logs) {
  const k = l.args.from.toLowerCase();
  sendersOk.set(k, (sendersOk.get(k) || 0) + 1);
}

console.log("=== Addresses that have successfully transferred Xvt ===");
for (const [addr, count] of [...sendersOk.entries()].sort((a,b) => b[1]-a[1])) {
  const isOwner = addr === OWNER.toLowerCase();
  const isZero = addr === "0x0000000000000000000000000000000000000000";
  console.log(`  ${addr} → ${count} transfers ${isOwner ? "(OWNER)" : isZero ? "(mint)" : ""}`);
}

// Full list of all transfers chronologically
console.log("\n=== Chronological transfer log ===");
for (const l of logs) {
  console.log(`block ${l.blockNumber} ${l.args.from.slice(0,12)}… → ${l.args.to.slice(0,12)}… ${formatUnits(l.args.value, 18)} tx=${l.transactionHash.slice(0,18)}…`);
}
