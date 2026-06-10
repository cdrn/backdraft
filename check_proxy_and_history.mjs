import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

// 1. Compare our proxy bytecode against known patterns
const ourProxy = "0x3d3d3d3d363d3d37363d732bb625daa0a9dd2c69939cbd6c2dbae2ac6667ac5af43d3d93803e602a57fd5bf3";

console.log("=== PROXY BYTECODE ANALYSIS ===\n");
console.log("Our proxy: ", ourProxy);
console.log("Bytes:     ", (ourProxy.length - 2) / 2);
console.log();
console.log("EIP-1167 standard: 0x363d3d373d3d3d363d73<addr>5af43d82803e903d91602b57fd5bf3 (45b)");
console.log("Our prefix:        0x3d3d3d3d363d3d37363d73<addr>5af43d3d93803e602a57fd5bf3   (44b)");
console.log();
console.log("Solady LibClone.cloneDeterministic produces this exact 44-byte variant.");
console.log("Source: https://github.com/Vectorized/solady/blob/main/src/utils/LibClone.sol");

// 2. Count how many transactions involve the impl as a target
const IMPL = "0x2BB625DAa0A9dD2C69939cBD6c2dBae2ac6667AC";
const latest = await client.getBlockNumber();
console.log(`\nLatest Base block: ${latest}`);

// We found earlier: impl deployed at block ~34197299 (2025-08-14)
const deployBlock = 34197299n;
const blocksSince = Number(latest - deployBlock);
const daysSince = blocksSince * 2 / 86400; // Base = 2s blocks
console.log(`Impl deployed: block ${deployBlock} (~2025-08-14)`);
console.log(`Days since: ~${daysSince.toFixed(0)} days`);

// Look at the impl contract's transaction count via getCode age — no direct way.
// But we can look at PoolCreated events from V3 factory in this period filtered by token0/token1
// being a proxy of this impl. That's expensive. Skip.

// Look at any direct calls to the impl
console.log("\n=== Recent activity AT the impl address ===");
// Just check the last 10k blocks for any logs originating from the impl
const recentBlock = latest - 10000n;
const codeSize = (await client.getCode({ address: IMPL })).length / 2 - 1;
console.log(`Impl code size: ${codeSize} bytes (still alive)`);
