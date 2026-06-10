import { createPublicClient, http, parseAbi, parseAbiItem, formatUnits, formatEther } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const POOL = "0xa82ef0D0e5b54e77732127c237942451D93C2BBc"; // GOTCHI pool
const WETH = "0x4200000000000000000000000000000000000006";

// Discover the token + ownership from the pool
const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);
const [t0, t1, fee] = await Promise.all([
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "token0" }),
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "token1" }),
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "fee" }),
]);
const TOKEN = t0.toLowerCase() === WETH.toLowerCase() ? t1 : t0;
const tokenIsToken0 = t0.toLowerCase() === TOKEN.toLowerCase();

console.log("=== GOTCHI ===");
console.log(`Token:     ${TOKEN}`);
console.log(`Pool:      ${POOL} (Uniswap V3 ${fee/10000}% fee tier)`);
console.log(`token0:    ${t0}`);
console.log(`token1:    ${t1}`);

// Token metadata + ownership
const TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function owner() view returns (address)",
]);
for (const fn of ["name","symbol","totalSupply","decimals","owner"]) {
  try {
    const r = await client.readContract({ address: TOKEN, abi: TOKEN_ABI, functionName: fn });
    console.log(`  ${fn}: ${typeof r === "bigint" ? r.toString() : r}`);
  } catch { console.log(`  ${fn}: <reverts>`); }
}

// Timeline of pool events
const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const V3_MINT = parseAbiItem("event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)");
const V3_SWAP = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");

const events = [];

// Token mints
for (const l of await client.getLogs({ address: TOKEN, event: TRANSFER, args: { from: ZERO }, fromBlock: 33500000n })) {
  events.push({ block: l.blockNumber, idx: l.logIndex, kind: "TOKEN_MINT",
    desc: `${formatUnits(l.args.value, 18)} ${TOKEN.slice(0,8)} → ${l.args.to}`,
    tx: l.transactionHash });
}

// LP add events
for (const l of await client.getLogs({ address: POOL, event: V3_MINT, fromBlock: 33500000n })) {
  const tokAmt = tokenIsToken0 ? l.args.amount0 : l.args.amount1;
  const wethAmt = tokenIsToken0 ? l.args.amount1 : l.args.amount0;
  events.push({ block: l.blockNumber, idx: l.logIndex, kind: "LP_ADD",
    desc: `lp_owner=${l.args.owner} TOKEN=${formatUnits(tokAmt, 18)} WETH=${formatEther(wethAmt)}`,
    tx: l.transactionHash });
}

// Swaps
for (const l of await client.getLogs({ address: POOL, event: V3_SWAP, fromBlock: 33500000n })) {
  const tokDelta = tokenIsToken0 ? l.args.amount0 : l.args.amount1;
  const wethDelta = tokenIsToken0 ? l.args.amount1 : l.args.amount0;
  const dir = tokDelta < 0n ? "BUY  (WETH→TOKEN)" : "SELL (TOKEN→WETH)";
  const tokAbs = tokDelta < 0n ? -tokDelta : tokDelta;
  const wethAbs = wethDelta < 0n ? -wethDelta : wethDelta;
  events.push({ block: l.blockNumber, idx: l.logIndex, kind: "SWAP",
    desc: `${dir} recipient=${l.args.recipient} TOKEN=${formatUnits(tokAbs, 18)} WETH=${formatEther(wethAbs)}`,
    tx: l.transactionHash });
}

events.sort((a, b) => a.block === b.block ? Number(a.idx - b.idx) : Number(a.block - b.block));

console.log("\n=== TIMELINE ===");
let lastTx = "";
for (const e of events) {
  if (e.tx !== lastTx) { console.log(`\nblock ${e.block} tx ${e.tx}`); lastTx = e.tx; }
  console.log(`  [${e.kind}] ${e.desc}`);
}
