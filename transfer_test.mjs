import { createPublicClient, http, parseAbi, parseEther, encodeFunctionData, encodeAbiParameters, keccak256, getAddress } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")),
});

const TOKEN = "0xb5295b5a763D27feA998E29e90349B9aD42c371E"; // HANTA
const POOL = "0xF6B5a2041643A87244f83C1384C39a17b05a3f3A";
const RANDOM_ADDR = "0x000000000000000000000000000000000000beef";
const VICTIM = "0x000000000000000000000000000000000000cafe";

const ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

// Find balance slot — try slot 0 (standard OZ ERC20)
// OZ ERC20 stores _balances at slot 0: balances[victim] = keccak(abi.encode(victim, 0))
const balSlot = (addr) => keccak256(encodeAbiParameters([{type:"address"}, {type:"uint256"}], [addr, 0n]));

const generousBalance = "0x" + (10n ** 24n).toString(16).padStart(64, "0"); // 1M tokens

console.log(`=== Token: ${TOKEN} (HANTA) ===`);

// Sanity: actual current balance
const realBal = await client.readContract({ address: TOKEN, abi: ABI, functionName: "balanceOf", args: [VICTIM] });
console.log(`Victim's real balance: ${realBal}`);

console.log("\n--- Test 1: transfer() to a random EOA (not the pool) ---");
try {
  const data = encodeFunctionData({ abi: ABI, functionName: "transfer", args: [RANDOM_ADDR, parseEther("1")] });
  await client.call({
    to: TOKEN, data, account: VICTIM,
    stateOverride: [{ address: TOKEN, stateDiff: { [balSlot(VICTIM)]: generousBalance } }],
  });
  console.log("  ✓ Transfer to random EOA: SUCCEEDS  ← victim can move tokens around");
} catch (e) {
  console.log("  ✗ Transfer to random EOA: REVERTS");
  console.log("    Cause:", e.shortMessage?.slice(0, 200));
}

console.log("\n--- Test 2: transfer() to the POOL (this is what 'selling' does internally) ---");
try {
  const data = encodeFunctionData({ abi: ABI, functionName: "transfer", args: [POOL, parseEther("1")] });
  await client.call({
    to: TOKEN, data, account: VICTIM,
    stateOverride: [{ address: TOKEN, stateDiff: { [balSlot(VICTIM)]: generousBalance } }],
  });
  console.log("  ✓ Transfer to pool: succeeds (not a recipient-based trap)");
} catch (e) {
  console.log("  ✗ Transfer to pool: REVERTS  ← THIS IS THE TRAP");
  console.log("    Cause:", e.shortMessage?.slice(0, 200));
  console.log("    Reason:", e.cause?.message?.slice(0, 200) || "(no reason returned)");
}

// Also try slot 51 just in case the contract uses upgradeable patterns
console.log("\n--- Test 3 (sanity): same with different storage slot guesses ---");
for (const guessSlot of [1, 2, 50, 51, 100]) {
  try {
    const s = keccak256(encodeAbiParameters([{type:"address"}, {type:"uint256"}], [VICTIM, BigInt(guessSlot)]));
    const data = encodeFunctionData({ abi: ABI, functionName: "transfer", args: [POOL, parseEther("0.001")] });
    await client.call({
      to: TOKEN, data, account: VICTIM,
      stateOverride: [{ address: TOKEN, stateDiff: { [s]: generousBalance } }],
    });
    console.log(`  slot ${guessSlot}: transfer to pool succeeded — balance is at this slot, NOT a recipient trap`);
    break;
  } catch (e) {
    console.log(`  slot ${guessSlot}: still reverts`);
  }
}
