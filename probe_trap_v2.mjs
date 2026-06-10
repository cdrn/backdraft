import { createPublicClient, http, parseAbi, encodeFunctionData, keccak256 } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const TOKEN = "0x0E27FB491Ce7208cB110a482ACfB92405E23cf3C";
const POOL  = "0xA3c1ee252A9A6A999fE79Bc3E75D71FFF586c4Bf";
const OWNER = "0x91508018F75F93AF3C8C7C501757f1Db57f19804";
const EOA   = "0x000000000000000000000000000000000000beef";
const RANDOM_EOA = "0x000000000000000000000000000000000000cafe";

const ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

// Solady ERC20 balance slot:
//   mstore(0x0c, _BALANCE_SLOT_SEED)  -> bytes 0x0c..0x2c get seed (right-aligned, 4 bytes at end)
//   mstore(0x00, owner)               -> bytes 0x00..0x20 get owner (right-aligned, 20 bytes at end)
//   slot = keccak256(0x0c, 0x20)
// So keccak input = bytes(0x0c..0x2c) = <20 bytes addr><8 zero bytes><4 bytes seed>
const _BALANCE_SLOT_SEED = "87a211a2";
function soladySlot(addr) {
  const a = addr.slice(2).toLowerCase().padStart(40, "0");
  const padded = a + "0".repeat(16) + _BALANCE_SLOT_SEED; // 40 + 16 + 8 = 64 hex chars
  return keccak256("0x" + padded);
}

// Sanity-check our slot derivation against the actual owner's balance
const ownerSlot = soladySlot(OWNER);
const ownerBalAtSlot = await client.getStorageAt({ address: TOKEN, slot: ownerSlot });
const ownerBalReadable = await client.readContract({ address: TOKEN, abi: ABI, functionName: "balanceOf", args: [OWNER] });
console.log(`Owner balance via balanceOf(): ${ownerBalReadable}`);
console.log(`Owner balance via storage slot ${ownerSlot}: ${BigInt(ownerBalAtSlot)}`);
console.log(`Slot derivation correct: ${BigInt(ownerBalAtSlot) === ownerBalReadable ? "✓ yes" : "✗ NO — slot wrong"}`);

const eoaSlot = soladySlot(EOA);
const generous = "0x" + (10n ** 24n).toString(16).padStart(64, "0");

console.log("\n=== Test A: EOA → another EOA (no pool involved) ===");
try {
  const data = encodeFunctionData({ abi: ABI, functionName: "transfer", args: [RANDOM_EOA, 1000n] });
  await client.call({
    to: TOKEN, data, account: EOA,
    stateOverride: [{ address: TOKEN, stateDiff: { [eoaSlot]: generous } }],
  });
  console.log("  ✓ Random EOA → EOA: WORKS");
} catch (e) {
  console.log("  ✗ Random EOA → EOA: REVERTS");
  console.log("    msg:", e.shortMessage?.slice(0,250), e.cause?.message?.slice(0,200));
}

console.log("\n=== Test B: EOA → POOL (the sell path) ===");
try {
  const data = encodeFunctionData({ abi: ABI, functionName: "transfer", args: [POOL, 1000n] });
  await client.call({
    to: TOKEN, data, account: EOA,
    stateOverride: [{ address: TOKEN, stateDiff: { [eoaSlot]: generous } }],
  });
  console.log("  ✓ Random EOA → POOL: WORKS (not a trap?)");
} catch (e) {
  console.log("  ✗ Random EOA → POOL: REVERTS — trap fires here");
  console.log("    msg:", e.shortMessage?.slice(0,250), e.cause?.message?.slice(0,200));
}
