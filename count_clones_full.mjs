import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const POOL_CREATED = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");
const IMPL_LC = "0x2bb625daa0a9dd2c69939cbd6c2dbae2ac6667ac"; // lowercase impl address

// Solady clone runtime prefix (everything up to the impl address)
const PROXY_PREFIX = "0x3d3d3d3d363d3d37363d73";
// Build the full expected bytecode
const EXPECTED = (PROXY_PREFIX + IMPL_LC.slice(2) + "5af43d3d93803e602a57fd5bf3").toLowerCase();

// Range: impl deployed at ~34197299, latest ~45831207
const START = 34197299n;
const END = 45831207n;
const CHUNK = 9999n; // viem-friendly chunk size

let totalPools = 0;
let cloneTokens = new Set();
let scanned = 0;

console.log(`Scanning V3 PoolCreated events on Base from ${START} → ${END}`);
console.log(`Expected proxy bytecode: ${EXPECTED}\n`);

for (let from = START; from < END; from += CHUNK + 1n) {
  const to = from + CHUNK > END ? END : from + CHUNK;
  try {
    const logs = await client.getLogs({
      address: V3_FACTORY,
      event: POOL_CREATED,
      fromBlock: from,
      toBlock: to,
    });
    totalPools += logs.length;

    // For each new pool, check token0 and token1 against the proxy pattern
    // Batch in parallel (10 at a time)
    const batchSize = 20;
    for (let i = 0; i < logs.length; i += batchSize) {
      const batch = logs.slice(i, i + batchSize);
      await Promise.all(batch.map(async (l) => {
        const candidates = [l.args.token0, l.args.token1];
        for (const t of candidates) {
          if (cloneTokens.has(t.toLowerCase())) continue;
          try {
            const code = await client.getCode({ address: t });
            if (code && code.toLowerCase() === EXPECTED) {
              cloneTokens.add(t.toLowerCase());
            }
          } catch {}
        }
      }));
    }

    scanned += Number(CHUNK + 1n);
    if (scanned % 100000 === 0) {
      const pct = (Number(from - START) / Number(END - START) * 100).toFixed(1);
      console.log(`  [${pct}%] scanned ${scanned} blocks | ${totalPools} pools | ${cloneTokens.size} clones found`);
    }
  } catch (e) {
    console.log(`  err at ${from}: ${e.shortMessage?.slice(0, 80)}`);
  }
}

console.log(`\n=== TOTAL ===`);
console.log(`V3 pools created in this period: ${totalPools}`);
console.log(`Clones of impl ${IMPL_LC} found: ${cloneTokens.size}`);
console.log(`Clone rate: ~${(cloneTokens.size / 269).toFixed(1)} per day over 9 months`);

import fs from "fs";
fs.writeFileSync("/Users/cdrn/Code/backdraft/clone_count.json", JSON.stringify([...cloneTokens], null, 2));
