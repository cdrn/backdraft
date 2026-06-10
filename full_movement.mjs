import { createPublicClient, http, parseAbiItem, formatUnits, formatEther } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")) });

const TOKEN = "0xb5295b5a763D27feA998E29e90349B9aD42c371E"; // HANTA
const POOL = "0xF6B5a2041643A87244f83C1384C39a17b05a3f3A";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const events = [];

// All HANTA transfers in/out of pool
const hantaIn = await client.getLogs({ address: TOKEN, event: TRANSFER, args: { to: POOL }, fromBlock: 25060000n });
const hantaOut = await client.getLogs({ address: TOKEN, event: TRANSFER, args: { from: POOL }, fromBlock: 25060000n });
const wethIn = await client.getLogs({ address: WETH, event: TRANSFER, args: { to: POOL }, fromBlock: 25060000n });
const wethOut = await client.getLogs({ address: WETH, event: TRANSFER, args: { from: POOL }, fromBlock: 25060000n });

for (const l of hantaIn) events.push({ block: l.blockNumber, logIndex: l.logIndex, kind: "HANTA→pool", amt: formatUnits(l.args.value, 18), peer: l.args.from, tx: l.transactionHash });
for (const l of hantaOut) events.push({ block: l.blockNumber, logIndex: l.logIndex, kind: "HANTA←pool", amt: formatUnits(l.args.value, 18), peer: l.args.to, tx: l.transactionHash });
for (const l of wethIn) events.push({ block: l.blockNumber, logIndex: l.logIndex, kind: "WETH→pool", amt: formatEther(l.args.value), peer: l.args.from, tx: l.transactionHash });
for (const l of wethOut) events.push({ block: l.blockNumber, logIndex: l.logIndex, kind: "WETH←pool", amt: formatEther(l.args.value), peer: l.args.to, tx: l.transactionHash });

events.sort((a, b) => a.block === b.block ? Number(a.logIndex - b.logIndex) : Number(a.block - b.block));

console.log("=== ALL TOKEN MOVEMENTS IN/OUT OF HANTA POOL ===\n");
let lastTx = "";
for (const e of events) {
  if (e.tx !== lastTx) { console.log(`\n--- tx ${e.tx} (block ${e.block}) ---`); lastTx = e.tx; }
  console.log(`  ${e.kind}: ${e.amt}  peer=${e.peer}`);
}
