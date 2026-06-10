import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

// Pick one of the proxies
const PROXY = "0x0E27FB491Ce7208cB110a482ACfB92405E23cf3C"; // Xvt
const code = await client.getCode({ address: PROXY });
console.log(`Proxy code: ${code}\n`);

// EIP-1167 layout: 0x363d3d373d3d3d363d73<20-byte addr>5af43d82803e903d91602b57fd5bf3
// The impl address is bytes 10..30 (after the leading 0x363d3d373d3d3d363d73)
const hex = code.slice(2);
// Skip the leading "363d3d373d3d3d363d73" (20 hex chars = 10 bytes)
const implRaw = "0x" + hex.slice(20, 60);
const impl = getAddress(implRaw);
console.log(`Implementation address: ${impl}`);

// Check if impl is a contract
const implCode = await client.getCode({ address: impl });
console.log(`Implementation code size: ${(implCode.length - 2) / 2} bytes`);

// Try standard ERC20 functions on the impl directly (might revert if abstract / requires init)
const ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function owner() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function implementation() view returns (address)",
]);
console.log("\nImpl direct calls:");
for (const fn of ["name", "symbol", "owner", "totalSupply"]) {
  try {
    const r = await client.readContract({ address: impl, abi: ABI, functionName: fn });
    console.log(`  ${fn}: ${typeof r === "bigint" ? r.toString() : r}`);
  } catch (e) {
    console.log(`  ${fn}: <reverts>`);
  }
}

// Count how many contracts on Base are proxies pointing to this same impl
// We can't easily search all of Base, but we can confirm via etherscan
console.log(`\nCheck etherscan: https://basescan.org/address/${impl}`);
console.log(`Look at "Contract" tab for source, "Transactions" for deploy origin, "Read Contract" for state.`);
