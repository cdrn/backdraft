import { createPublicClient, http, parseAbi, formatEther } from "viem";
import { mainnet, base } from "viem/chains";
import fs from "fs";
import "dotenv/config";

const clients = {
  ethereum: createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")) }),
  base: createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) }),
};
const FACTORIES = {
  ethereum: {
    v2: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    v3: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  },
  base: {
    v2: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    v3: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  },
};

const PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

const lines = fs.readFileSync("/Users/cdrn/Code/backdraft/honeypots.txt", "utf8").trim().split("\n");

const results = { v2: [], v3: [], unknown: [] };

for (const line of lines) {
  const [pool, chain, symbol, deployBlock] = line.split("|");
  const client = clients[chain];
  let kind = "unknown";

  // Test for V2: has getReserves
  try {
    await client.readContract({ address: pool, abi: PAIR_ABI, functionName: "getReserves" });
    kind = "v2";
  } catch {
    // Test for V3: has fee()
    try {
      await client.readContract({ address: pool, abi: PAIR_ABI, functionName: "fee" });
      kind = "v3";
    } catch {}
  }
  results[kind].push({ pool, chain, symbol, deployBlock });
  process.stdout.write(kind === "v2" ? "2" : kind === "v3" ? "3" : "?");
}

console.log("\n");
console.log(`V2 pools (real honeypot candidates): ${results.v2.length}`);
console.log(`V3 pools (likely false positives due to V2-only detector bug): ${results.v3.length}`);
console.log(`Unknown / drained: ${results.unknown.length}`);

console.log("\n=== V2 (real-honeypot candidates) ===");
for (const r of results.v2) console.log(`  ${r.symbol.padEnd(15)} ${r.chain.padEnd(9)} ${r.pool}`);

console.log("\n=== V3 (false-positive candidates) ===");
for (const r of results.v3) console.log(`  ${r.symbol.padEnd(15)} ${r.chain.padEnd(9)} ${r.pool}`);

console.log("\n=== Unknown / pool drained ===");
for (const r of results.unknown) console.log(`  ${r.symbol.padEnd(15)} ${r.chain.padEnd(9)} ${r.pool}`);

fs.writeFileSync("/Users/cdrn/Code/backdraft/honeypots_by_pool_type.json", JSON.stringify(results, null, 2));
