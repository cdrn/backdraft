import { createPublicClient, http, parseAbi, parseAbiItem, formatEther } from "viem";
import { mainnet, base } from "viem/chains";
import fs from "fs";
import "dotenv/config";

const ethRpc = process.env.ETH_RPC_WS.replace("wss://", "https://");
const baseRpc = process.env.BASE_RPC_WS.replace("wss://", "https://");

const clients = {
  ethereum: createPublicClient({ chain: mainnet, transport: http(ethRpc) }),
  base: createPublicClient({ chain: base, transport: http(baseRpc) }),
};

const WETH = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  base: "0x4200000000000000000000000000000000000006",
};

const EXPLORER = {
  ethereum: "https://etherscan.io",
  base: "https://basescan.org",
};

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

const lines = fs.readFileSync("/Users/cdrn/Code/backdraft/honeypots.txt", "utf8").trim().split("\n");

const results = [];

for (const line of lines) {
  const [pool, chain, symbol, deployBlock] = line.split("|");
  const client = clients[chain];

  try {
    const fromBlock = BigInt(deployBlock || 0);
    const [tIn, tOut] = await Promise.all([
      client.getLogs({ address: WETH[chain], event: TRANSFER, args: { to: pool }, fromBlock, toBlock: "latest" }),
      client.getLogs({ address: WETH[chain], event: TRANSFER, args: { from: pool }, fromBlock, toBlock: "latest" }),
    ]);

    const totalIn = tIn.reduce((a, l) => a + l.args.value, 0n);
    const totalOut = tOut.reduce((a, l) => a + l.args.value, 0n);
    const netStuck = totalIn - totalOut;

    const isHoneypot = totalOut < totalIn / 10n;

    results.push({
      chain, symbol, pool,
      in_eth: parseFloat(formatEther(totalIn)),
      out_eth: parseFloat(formatEther(totalOut)),
      net_eth: parseFloat(formatEther(netStuck)),
      n_in: tIn.length,
      n_out: tOut.length,
      isHoneypot,
      url: `${EXPLORER[chain]}/address/${pool}`,
    });
    process.stdout.write(".");
  } catch (err) {
    process.stdout.write("x");
  }
}

console.log("\n");

const real = results.filter(r => r.isHoneypot);
const falsePositives = results.filter(r => !r.isHoneypot);

const totalCaptured = real.reduce((a, r) => a + r.net_eth, 0);
const totalGrossIn = real.reduce((a, r) => a + r.in_eth, 0);

console.log("=== METHODOLOGY ===");
console.log("Real honeypot = WETH OUT < WETH IN / 10 (operator drains but vast majority stays trapped)");
console.log("False positive = bidirectional volume (legit pool flagged during a sell-sim glitch)\n");

console.log("=== RESULTS ===");
console.log(`Real honeypots: ${real.length} / ${results.length}`);
console.log(`False positives: ${falsePositives.length}`);
console.log(`Total gross WETH IN to real honeypots: ${totalGrossIn.toFixed(4)} ETH`);
console.log(`Total NET captured (still locked): ${totalCaptured.toFixed(4)} ETH`);
console.log(`Approx USD value (at $3000/ETH): $${(totalGrossIn * 3000).toFixed(2)} gross, $${(totalCaptured * 3000).toFixed(2)} captured\n`);

console.log("=== REAL HONEYPOTS ===");
const sorted = real.sort((a, b) => b.net_eth - a.net_eth);
for (const r of sorted) {
  console.log(`  ${r.symbol.padEnd(15)} ${r.chain.padEnd(9)} in=${r.in_eth.toFixed(4).padStart(10)} ETH | net=${r.net_eth.toFixed(4).padStart(10)} ETH  ${r.url}`);
}

console.log("\n=== FALSE POSITIVES (legit pools we wrongly flagged) ===");
for (const r of falsePositives.sort((a,b)=>b.in_eth - a.in_eth)) {
  console.log(`  ${r.symbol.padEnd(15)} ${r.chain.padEnd(9)} in=${r.in_eth.toFixed(4).padStart(12)} out=${r.out_eth.toFixed(4).padStart(12)}  ${r.url}`);
}
