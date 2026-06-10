import { createPublicClient, http, keccak256 } from "viem";
import { mainnet, base } from "viem/chains";
import fs from "fs";
import "dotenv/config";

const clients = {
  ethereum: createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")) }),
  base: createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) }),
};

const lines = fs.readFileSync("/Users/cdrn/Code/backdraft/honeypot_tokens.txt", "utf8").trim().split("\n");

const clusters = new Map(); // hash -> [tokens]

for (const line of lines) {
  const [token, chain, symbol] = line.split("|");
  if (!token || token === "null") continue;
  try {
    const code = await clients[chain].getCode({ address: token });
    if (!code || code === "0x") { process.stdout.write("?"); continue; }
    const hash = keccak256(code);
    if (!clusters.has(hash)) clusters.set(hash, []);
    clusters.get(hash).push({ token, chain, symbol, size: (code.length - 2) / 2 });
    process.stdout.write(".");
  } catch { process.stdout.write("x"); }
}

console.log("\n\n=== BYTECODE CLUSTERS ===\n");
const sorted = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [hash, tokens] of sorted) {
  console.log(`\nCluster (${tokens.length} tokens, ${tokens[0].size} bytes) hash=${hash.slice(0, 18)}...`);
  for (const t of tokens) {
    console.log(`  ${t.symbol.padEnd(15)} ${t.chain.padEnd(10)} ${t.token}`);
  }
}

console.log(`\n${clusters.size} unique bytecodes across ${lines.length} honeypots`);
const dups = sorted.filter(([_, ts]) => ts.length > 1);
const uniq = sorted.filter(([_, ts]) => ts.length === 1);
console.log(`${dups.length} clusters with multiple tokens, ${uniq.length} singletons`);
if (dups.length > 0) {
  const dupCount = dups.reduce((a, [_, ts]) => a + ts.length, 0);
  console.log(`${dupCount} tokens (${(dupCount/lines.length*100).toFixed(0)}%) share bytecode with at least one other`);
}
