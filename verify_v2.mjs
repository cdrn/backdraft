import { createPublicClient, http, parseAbi, encodeFunctionData, keccak256 } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const TOKEN = "0x0E27FB491Ce7208cB110a482ACfB92405E23cf3C";
const EOA   = "0x000000000000000000000000000000000000beef";
const RANDOM_EOA = "0x000000000000000000000000000000000000cafe";

const _BALANCE_SLOT_SEED = "87a211a2";
function soladySlot(addr) {
  const a = addr.slice(2).toLowerCase().padStart(40, "0");
  return keccak256("0x" + a + "0".repeat(16) + _BALANCE_SLOT_SEED);
}
const eoaSlot = soladySlot(EOA);
const generous = "0x" + (10n ** 24n).toString(16).padStart(64, "0");

// viem wants stateDiff as ARRAY of {slot, value}
const override = [{
  address: TOKEN,
  stateDiff: [{ slot: eoaSlot, value: generous }],
}];

console.log("=== Verify override actually applies ===");
const ABI = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"]);

const bal = await client.readContract({
  address: TOKEN, abi: ABI, functionName: "balanceOf", args: [EOA],
  stateOverride: override,
});
console.log(`EOA balance with override: ${bal}`);

console.log("\n=== Transfer with override ===");
try {
  await client.simulateContract({
    address: TOKEN, abi: ABI, functionName: "transfer", args: [RANDOM_EOA, 1000n],
    account: EOA,
    stateOverride: override,
  });
  console.log("✓ Transfer SUCCEEDS — token is freely transferable when you have a balance");
  console.log("  Conclusion: there is NO from-side trap on transfer()");
} catch (e) {
  console.log("✗ REVERT");
  console.log("  shortMessage:", e.shortMessage?.slice(0, 200));
  console.log("  details:", e.details?.slice(0, 200));
}
