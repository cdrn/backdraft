import { createPublicClient, http, parseAbiItem, formatUnits, formatEther } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")),
});

const TOKEN = "0xb5295b5a763D27feA998E29e90349B9aD42c371E";
const POOL = "0xF6B5a2041643A87244f83C1384C39a17b05a3f3A";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const OWNER = "0x514C52CfD8Db898A95FDCEccBEe6e6556945630E".toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const MINT = parseAbiItem("event Mint(address indexed sender, uint256 amount0, uint256 amount1)");
const BURN = parseAbiItem("event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)");
const SWAP = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");

const events = [];

// Token mints
for (const l of await client.getLogs({ address: TOKEN, event: TRANSFER, args: { from: ZERO }, fromBlock: 22000000n })) {
  events.push({ block: l.blockNumber, kind: "TOKEN_MINT", desc: `${formatUnits(l.args.value, 18)} HANTA → ${l.args.to.slice(0,10)}…`, tx: l.transactionHash });
}

// Pool LP mints (liquidity adds)
for (const l of await client.getLogs({ address: POOL, event: MINT, fromBlock: 22000000n })) {
  events.push({ block: l.blockNumber, kind: "LP_MINT", desc: `add liq sender=${l.args.sender.slice(0,10)}… a0=${l.args.amount0} a1=${l.args.amount1}`, tx: l.transactionHash });
}

// Pool LP burns (liquidity removes)
for (const l of await client.getLogs({ address: POOL, event: BURN, fromBlock: 22000000n })) {
  events.push({ block: l.blockNumber, kind: "LP_BURN", desc: `REMOVE liq → ${l.args.to.slice(0,10)}… a0=${l.args.amount0} a1=${l.args.amount1}`, tx: l.transactionHash });
}

// Pool swaps
for (const l of await client.getLogs({ address: POOL, event: SWAP, fromBlock: 22000000n })) {
  const a0in = l.args.amount0In, a1in = l.args.amount1In, a0out = l.args.amount0Out, a1out = l.args.amount1Out;
  events.push({
    block: l.blockNumber,
    kind: "SWAP",
    desc: `to=${l.args.to.slice(0,10)}… in:[${a0in},${a1in}] out:[${a0out},${a1out}]`,
    tx: l.transactionHash,
  });
}

events.sort((a, b) => Number(a.block - b.block));
console.log("=== FULL HANTA POOL TIMELINE ===\n");
for (const e of events) {
  console.log(`block ${e.block} | ${e.kind.padEnd(11)} | ${e.desc}`);
  console.log(`  tx: https://etherscan.io/tx/${e.tx}`);
}

// Find which is token0 to interpret swap amounts
const t0 = await client.readContract({
  address: POOL, abi: [{name:"token0",type:"function",stateMutability:"view",inputs:[],outputs:[{type:"address"}]}], functionName: "token0"
});
console.log(`\ntoken0 = ${t0}`);
console.log(`(WETH is ${t0.toLowerCase() === WETH.toLowerCase() ? "token0" : "token1"}, HANTA is the other)`);
