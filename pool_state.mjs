import { createPublicClient, http, parseAbi, parseAbiItem, formatUnits, formatEther } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const POOL = "0xA3c1ee252A9A6A999fE79Bc3E75D71FFF586c4Bf"; // Xvt pool
const TOKEN = "0x0E27FB491Ce7208cB110a482ACfB92405E23cf3C";
const WETH = "0x4200000000000000000000000000000000000006";

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const [t0, t1, fee, ts] = await Promise.all([
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "token0" }),
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "token1" }),
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "fee" }),
  client.readContract({ address: POOL, abi: POOL_ABI, functionName: "tickSpacing" }),
]);
const slot0 = await client.readContract({ address: POOL, abi: POOL_ABI, functionName: "slot0" });
const liq = await client.readContract({ address: POOL, abi: POOL_ABI, functionName: "liquidity" });

const tokIsT0 = t0.toLowerCase() === TOKEN.toLowerCase();
const tokBal = await client.readContract({ address: TOKEN, abi: ERC20, functionName: "balanceOf", args: [POOL] });
const wethBal = await client.readContract({ address: WETH, abi: ERC20, functionName: "balanceOf", args: [POOL] });

console.log(`=== Xvt POOL STATE ===`);
console.log(`token0: ${t0} ${tokIsT0 ? "(Xvt)" : "(WETH)"}`);
console.log(`token1: ${t1} ${!tokIsT0 ? "(Xvt)" : "(WETH)"}`);
console.log(`fee: ${fee} (${Number(fee)/10000}%)`);
console.log(`tickSpacing: ${ts}`);
console.log(`sqrtPriceX96: ${slot0[0]}`);
console.log(`current tick: ${slot0[1]}`);
console.log(`active liquidity at current tick: ${liq}`);
console.log(`Pool's Xvt balance: ${formatUnits(tokBal, 18)}`);
console.log(`Pool's WETH balance: ${formatEther(wethBal)}`);

// Look at the LP Mint events to see exactly what tick range was used
const V3_MINT = parseAbiItem("event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)");
const V3_BURN = parseAbiItem("event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)");

console.log("\n=== LP MINTS ===");
for (const l of await client.getLogs({ address: POOL, event: V3_MINT, fromBlock: 33000000n })) {
  const aTok = tokIsT0 ? l.args.amount0 : l.args.amount1;
  const aW = tokIsT0 ? l.args.amount1 : l.args.amount0;
  console.log(`  block ${l.blockNumber} owner=${l.args.owner} ticks=[${l.args.tickLower}..${l.args.tickUpper}] liq=${l.args.amount}`);
  console.log(`    deposited Xvt=${formatUnits(aTok, 18)} WETH=${formatEther(aW)}`);
}
console.log("\n=== LP BURNS ===");
for (const l of await client.getLogs({ address: POOL, event: V3_BURN, fromBlock: 33000000n })) {
  const aTok = tokIsT0 ? l.args.amount0 : l.args.amount1;
  const aW = tokIsT0 ? l.args.amount1 : l.args.amount0;
  console.log(`  block ${l.blockNumber} owner=${l.args.owner} ticks=[${l.args.tickLower}..${l.args.tickUpper}] liq=${l.args.amount}`);
  console.log(`    withdrew Xvt=${formatUnits(aTok, 18)} WETH=${formatEther(aW)}`);
}
