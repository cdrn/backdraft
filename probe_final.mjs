import { createPublicClient, http, parseAbi, keccak256 } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const TOKEN = "0x0E27FB491Ce7208cB110a482ACfB92405E23cf3C";
const POOL  = "0xA3c1ee252A9A6A999fE79Bc3E75D71FFF586c4Bf";
const EOA   = "0x000000000000000000000000000000000000beef";
const RANDOM_EOA = "0x000000000000000000000000000000000000cafe";

const _BALANCE_SLOT_SEED = "87a211a2";
function soladySlot(addr) {
  return keccak256("0x" + addr.slice(2).toLowerCase().padStart(40, "0") + "0".repeat(16) + _BALANCE_SLOT_SEED);
}
const generous = "0x" + (10n ** 24n).toString(16).padStart(64, "0");
const override = [{ address: TOKEN, stateDiff: [{ slot: soladySlot(EOA), value: generous }] }];

const ABI = parseAbi(["function transfer(address, uint256) returns (bool)"]);

async function test(name, args) {
  try {
    await client.simulateContract({ address: TOKEN, abi: ABI, functionName: "transfer", args, account: EOA, stateOverride: override });
    console.log(`  ✓ ${name}: WORKS`);
  } catch (e) {
    console.log(`  ✗ ${name}: REVERTS — ${e.shortMessage?.slice(0,150)}`);
  }
}

console.log("Test 1: EOA → another EOA (no pool involved)");
await test("EOA → EOA", [RANDOM_EOA, 1000n]);

console.log("\nTest 2: EOA → POOL (the sell path internal action)");
await test("EOA → POOL", [POOL, 1000n]);

console.log("\nTest 3: EOA → self");
await test("EOA → self", [EOA, 1000n]);

console.log("\nTest 4: EOA → zero address");
await test("EOA → 0x0", ["0x0000000000000000000000000000000000000000", 1000n]);
