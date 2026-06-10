import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

// Pick one of the proxies (Xvt)
const PROXY = "0x0E27FB491Ce7208cB110a482ACfB92405E23cf3C";
const code = await client.getCode({ address: PROXY });
const hex = code.slice(2);
console.log(`Proxy: ${PROXY}`);
console.log(`Bytecode (${hex.length / 2}b): 0x${hex}\n`);

// Find the address inside the proxy code
// Pattern: ...363d73<addr>5af4... — extract 40 hex chars (20 bytes) after `363d73`
const m = hex.match(/363d73([0-9a-f]{40})/i);
if (!m) {
  console.log("Not a standard minimal proxy");
  process.exit(1);
}
const impl = getAddress("0x" + m[1]);
console.log(`Implementation: ${impl}`);
console.log(`  https://basescan.org/address/${impl}`);

const implCode = await client.getCode({ address: impl });
if (!implCode || implCode === "0x") {
  console.log("  Implementation has NO code — selfdestructed or never deployed");
} else {
  console.log(`  Code size: ${(implCode.length - 2) / 2} bytes`);
}

// Try direct calls
const ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function owner() view returns (address)",
  "function totalSupply() view returns (uint256)",
]);
console.log("\nDirect calls on impl:");
for (const fn of ["name", "symbol", "owner", "totalSupply"]) {
  try {
    const r = await client.readContract({ address: impl, abi: ABI, functionName: fn });
    console.log(`  ${fn}: ${typeof r === "bigint" ? r.toString() : r}`);
  } catch (e) {
    console.log(`  ${fn}: <reverts>`);
  }
}
