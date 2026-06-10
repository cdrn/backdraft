import { createPublicClient, http, parseAbiItem, formatUnits, formatEther } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")) });

const TOKEN = "0xb5295b5a763D27feA998E29e90349B9aD42c371E";
const POOL = "0xF6B5a2041643A87244f83C1384C39a17b05a3f3A";
const OWNER = "0x514C52CfD8Db898A95FDCEccBEe6e6556945630E";
const ZERO = "0x0000000000000000000000000000000000000000";

const ERC_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const V3_MINT = parseAbiItem("event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)");
const V3_BURN = parseAbiItem("event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)");
const V3_SWAP = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");

const events = [];

// TOKEN mints (token0 is HANTA)
for (const l of await client.getLogs({ address: TOKEN, event: ERC_TRANSFER, args: { from: ZERO }, fromBlock: 22000000n })) {
  events.push({ block: l.blockNumber, kind: "TOKEN_MINT", a: `${formatUnits(l.args.value, 18)} HANTA → ${l.args.to.slice(0,10)}…`, tx: l.transactionHash });
}

// V3 pool mints (add liquidity)
for (const l of await client.getLogs({ address: POOL, event: V3_MINT, fromBlock: 22000000n })) {
  events.push({
    block: l.blockNumber, kind: "POOL_ADD_LIQ",
    a: `owner=${l.args.owner.slice(0,10)}… HANTA=${formatUnits(l.args.amount0, 18)} WETH=${formatEther(l.args.amount1)} ticks=[${l.args.tickLower},${l.args.tickUpper}]`,
    tx: l.transactionHash,
  });
}

// V3 pool burns (remove liquidity)
for (const l of await client.getLogs({ address: POOL, event: V3_BURN, fromBlock: 22000000n })) {
  events.push({
    block: l.blockNumber, kind: "POOL_REMOVE_LIQ",
    a: `owner=${l.args.owner.slice(0,10)}… HANTA=${formatUnits(l.args.amount0, 18)} WETH=${formatEther(l.args.amount1)}`,
    tx: l.transactionHash,
  });
}

// V3 swaps
for (const l of await client.getLogs({ address: POOL, event: V3_SWAP, fromBlock: 22000000n })) {
  const a0 = l.args.amount0; // HANTA delta (positive = in, negative = out from pool)
  const a1 = l.args.amount1; // WETH delta
  const direction = a0 > 0n ? "BUY (WETH→HANTA)" : "SELL (HANTA→WETH)";
  events.push({
    block: l.blockNumber, kind: "SWAP",
    a: `${direction} recipient=${l.args.recipient.slice(0,10)}… HANTA=${formatUnits(a0 < 0n ? -a0 : a0, 18)} WETH=${formatEther(a1 < 0n ? -a1 : a1)}`,
    tx: l.transactionHash,
  });
}

events.sort((a, b) => Number(a.block - b.block));
console.log("=== FULL HANTA POOL TIMELINE (Uniswap V3 0.01%) ===\n");
for (const e of events) {
  console.log(`block ${e.block} | ${e.kind.padEnd(16)} | ${e.a}`);
  console.log(`  tx: https://etherscan.io/tx/${e.tx}`);
}
