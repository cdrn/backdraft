import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const IMPL = "0x2BB625DAa0A9dD2C69939cBD6c2dBae2ac6667AC";

// Get contract creation tx via Basescan-style API… or just look at the implementation's history.
// Strategy: query DelegateCall events / look at txs where impl's code executes.
// Easier: search for proxies via known bytecode pattern. Each clone has identical 44-byte code.
// The first deploy of the impl will be the genesis of this factory.

// Find when impl was deployed (its first appearance in chain history) via getCode at past blocks
const latest = await client.getBlockNumber();
console.log(`Current block: ${latest}`);

// Find approximate deploy block via binary search
let lo = 30000000n, hi = latest;
while (lo < hi) {
  const mid = (lo + hi) / 2n;
  const code = await client.getCode({ address: IMPL, blockNumber: mid });
  if (code && code !== "0x") hi = mid;
  else lo = mid + 1n;
}
console.log(`Implementation deployed at block ~${lo}`);

// Quick scan: get all transactions to the impl in last N blocks. Each is a clone-call-through.
// Better: use eth_getLogs for delegate calls (no log opcode for that). So can't.
// Alternative: query a 4byte block range looking at logs from any address matching impl pattern.
// That's expensive without an indexer.

// Pragmatic approach: ask the user to check Basescan's "Internal txns" tab for the impl,
// or use a service. For now: report the deploy block and let them verify.

console.log(`\nTo count clones, check on Basescan:`);
console.log(`  ${`https://basescan.org/txs?a=${IMPL}&p=1`}`);
console.log(`Or its internal transactions tab — every clone calls into it via DELEGATECALL.`);

// One more useful thing — get the deployer of the implementation
const block = await client.getBlock({ blockNumber: lo });
console.log(`\nDeploy block timestamp: ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
