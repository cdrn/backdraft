import { createPublicClient, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")),
});

// The 4-token cluster with identical bytecode
const cluster = [
  { sym: "LO0P (a)", addr: "0x24eA757FcF6190F615eF0d660e3Df1113d0Ed013" },
  { sym: "LO0P (b)", addr: "0x90842ddC2DB49C2f9b747a0397507cd7680627A5" },
  { sym: "HANTA",    addr: "0xb5295b5a763D27feA998E29e90349B9aD42c371E" },
  { sym: "SR",       addr: "0xccf2DCa37A33798F7598d3105C5423B5B5e81aB3" },
];

const ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function owner() view returns (address)",
]);

for (const t of cluster) {
  console.log(`\n=== ${t.sym} (${t.addr}) ===`);
  for (const fn of ["name", "totalSupply", "decimals", "owner"]) {
    try {
      const r = await client.readContract({ address: t.addr, abi: ABI, functionName: fn });
      console.log(`  ${fn}:`, r);
    } catch (e) {
      console.log(`  ${fn}: <reverts>`);
    }
  }
  // Get deployer from the first transaction
  const code = await client.getCode({ address: t.addr });
  console.log(`  bytecode size: ${(code.length - 2) / 2} bytes`);
}
