import { createPublicClient, http, parseAbi, encodeFunctionData, keccak256 } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const TOKEN = "0x0E27FB491Ce7208cB110a482ACfB92405E23cf3C";
const EOA   = "0x000000000000000000000000000000000000beef";
const RANDOM_EOA = "0x000000000000000000000000000000000000cafe";
const POOL = "0xA3c1ee252A9A6A999fE79Bc3E75D71FFF586c4Bf";
const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
]);

const _BALANCE_SLOT_SEED = "87a211a2";
function soladySlot(addr) {
  const a = addr.slice(2).toLowerCase().padStart(40, "0");
  return keccak256("0x" + a + "0".repeat(16) + _BALANCE_SLOT_SEED);
}
const eoaSlot = soladySlot(EOA);
const generous = "0x" + (10n ** 24n).toString(16).padStart(64, "0");

console.log("Step 1 — read EOA balance WITHOUT override:");
const bal1 = await client.readContract({ address: TOKEN, abi: ABI, functionName: "balanceOf", args: [EOA] });
console.log(`  ${bal1}`);

console.log("\nStep 2 — read EOA balance WITH override:");
const callData = encodeFunctionData({ abi: ABI, functionName: "balanceOf", args: [EOA] });
const result = await client.call({
  to: TOKEN, data: callData,
  stateOverride: [{ address: TOKEN, stateDiff: { [eoaSlot]: generous } }],
});
console.log(`  raw result: ${result.data}`);
console.log(`  decoded: ${BigInt(result.data)}`);

console.log("\nStep 3 — transfer with the SAME override:");
try {
  const data = encodeFunctionData({ abi: ABI, functionName: "transfer", args: [RANDOM_EOA, 1000n] });
  const r = await client.call({
    to: TOKEN, data, account: EOA,
    stateOverride: [{ address: TOKEN, stateDiff: { [eoaSlot]: generous } }],
  });
  console.log(`  ✓ Transfer SUCCEEDS — returned: ${r.data}`);
} catch (e) {
  console.log("  ✗ REVERT");
  const m = e.message || "";
  // Try to extract revert data
  const match = m.match(/data\s*[:=]\s*([0-9a-fx]+)/i) || m.match(/(0x[a-f0-9]+)/i);
  console.log("  shortMessage:", e.shortMessage?.slice(0, 200));
  console.log("  message tail:", m.slice(-400));
}
