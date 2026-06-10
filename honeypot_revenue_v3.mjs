import { createPublicClient, http, parseAbiItem, formatEther } from "viem";
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
const EXPLORER = { ethereum: "https://etherscan.io", base: "https://basescan.org" };
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

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

    // Track unique senders of WETH IN (= buyers, via router)
    const buyerSenders = new Set(tIn.map(l => l.args.from.toLowerCase()));
    const outRecipients = new Set(tOut.map(l => l.args.to.toLowerCase()));

    // Heuristic: legit pool has high tx count AND diverse recipients
    // Honeypot: low tx count OR very concentrated recipients
    const isLegit = tIn.length > 30 && outRecipients.size > 10;

    results.push({
      chain, symbol, pool,
      in_eth: parseFloat(formatEther(totalIn)),
      out_eth: parseFloat(formatEther(totalOut)),
      n_in: tIn.length, n_out: tOut.length,
      uniq_buyers: buyerSenders.size,
      uniq_out_recipients: outRecipients.size,
      isLegit,
      url: `${EXPLORER[chain]}/address/${pool}`,
    });
    process.stdout.write(".");
  } catch (err) { process.stdout.write("x"); }
}

console.log("\n\n=== METHODOLOGY ===");
console.log("Legit pool (false positive in detector): >30 swaps AND >10 unique OUT recipients");
console.log("Honeypot: anything else. The 'capture' is gross WETH IN (operator drains everything back to themselves).\n");

const honeypots = results.filter(r => !r.isLegit);
const legit = results.filter(r => r.isLegit);

const totalIn = honeypots.reduce((a, r) => a + r.in_eth, 0);
const totalOut = honeypots.reduce((a, r) => a + r.out_eth, 0);

console.log(`Detected honeypots:    ${honeypots.length}`);
console.log(`False positives:       ${legit.length} (legit high-vol memecoins flagged during sell-sim glitch)`);
console.log(`Gross WETH funneled through honeypot pools: ${totalIn.toFixed(4)} ETH (~$${(totalIn*3000).toFixed(0)})`);
console.log(`Net WETH still locked:                       ${(totalIn - totalOut).toFixed(4)} ETH\n`);

const sorted = honeypots.sort((a, b) => b.in_eth - a.in_eth);
console.log("=== REAL HONEYPOTS (sorted by gross WETH IN) ===\n");
for (const r of sorted) {
  console.log(`${r.symbol.padEnd(12)} ${r.chain.padEnd(9)} | IN: ${r.in_eth.toFixed(4).padStart(10)} ETH (${String(r.n_in).padStart(3)} tx) | OUT: ${r.out_eth.toFixed(4).padStart(10)} (${String(r.n_out).padStart(3)} tx) | ${r.url}`);
}

console.log("\n=== FALSE POSITIVES (legit pools wrongly flagged) ===\n");
for (const r of legit.sort((a,b) => b.in_eth - a.in_eth)) {
  console.log(`${r.symbol.padEnd(12)} ${r.chain.padEnd(9)} | IN: ${r.in_eth.toFixed(4).padStart(10)} (${r.n_in} tx, ${r.uniq_out_recipients} recipients) | ${r.url}`);
}
