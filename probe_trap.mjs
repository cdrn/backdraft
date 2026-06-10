import { createPublicClient, http, parseAbi, parseAbiItem, encodeFunctionData, encodeAbiParameters, keccak256 } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

// Use a "live" honeypot — pick one of the factory proxies with current liquidity.
// Xvt has the most recent activity per our earlier scan.
const TOKEN = "0x0E27FB491Ce7208cB110a482ACfB92405E23cf3C"; // Xvt token (proxy)
const POOL  = "0xA3c1ee252A9A6A999fE79Bc3E75D71FFF586c4Bf"; // Xvt pool (V3, 1%)
const WETH  = "0x4200000000000000000000000000000000000006";
const OWNER = "0x91508018F75F93AF3C8C7C501757f1Db57f19804";  // operator
const EOA   = "0x000000000000000000000000000000000000beef";
const RANDOM_EOA = "0x000000000000000000000000000000000000cafe";

console.log(`Token: ${TOKEN} (Xvt)`);

// Find owner via owner() — confirm
const ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
  "function totalSupply() view returns (uint256)",
]);

const realOwner = await client.readContract({ address: TOKEN, abi: ABI, functionName: "owner" });
console.log(`Real owner: ${realOwner}`);
const supply = await client.readContract({ address: TOKEN, abi: ABI, functionName: "totalSupply" });
console.log(`Supply: ${supply}`);

// Try state-overrides to give EOA balance. Solady ERC20 stores balances at keccak256(0x87a211a2 || addr).
// But we don't need state overrides — we can call transfer FROM the OWNER directly via eth_call
// using `from: OWNER`. The owner has the full supply.

console.log("\n=== Test 1: transfer FROM owner TO an EOA (non-pool) ===");
try {
  const data = encodeFunctionData({ abi: ABI, functionName: "transfer", args: [EOA, 1000n] });
  await client.call({ to: TOKEN, data, account: realOwner });
  console.log("  ✓ Owner can transfer to EOA");
} catch (e) { console.log("  ✗ revert:", e.shortMessage?.slice(0, 200)); }

console.log("\n=== Test 2: transfer FROM owner TO the pool ===");
try {
  const data = encodeFunctionData({ abi: ABI, functionName: "transfer", args: [POOL, 1000n] });
  await client.call({ to: TOKEN, data, account: realOwner });
  console.log("  ✓ Owner can transfer to pool (this is the drain path)");
} catch (e) { console.log("  ✗ revert:", e.shortMessage?.slice(0, 200)); }

// Now: can a random EOA do anything? We need balance though.
// Solady's balance slot uses a salted layout: keccak(0x87a211a2 || addr) for balances.
// Actually it's: keccak256(abi.encodePacked(uint96(_BALANCE_SLOT_SEED), addr))
// _BALANCE_SLOT_SEED = 0x87a211a2; from Solady source.
const slotSeed = 0x87a211a2;
const balSlot = keccak256(("0x" + slotSeed.toString(16).padStart(8,"0") + EOA.slice(2).padStart(64,"0")).toLowerCase());

console.log(`\nTrying balance slot ${balSlot.slice(0,18)}… for EOA via state override...`);
const generousBal = "0x" + (10n ** 24n).toString(16).padStart(64, "0");

console.log("\n=== Test 3: random EOA transfer to ANOTHER EOA ===");
try {
  const data = encodeFunctionData({ abi: ABI, functionName: "transfer", args: [RANDOM_EOA, 1000n] });
  await client.call({
    to: TOKEN, data, account: EOA,
    stateOverride: [{ address: TOKEN, stateDiff: { [balSlot]: generousBal } }],
  });
  console.log("  ✓ Random EOA can transfer to another EOA (trap is to-pool only)");
} catch (e) { console.log("  ✗ revert:", e.shortMessage?.slice(0, 200)); }

console.log("\n=== Test 4: random EOA transfer TO POOL (the sell path) ===");
try {
  const data = encodeFunctionData({ abi: ABI, functionName: "transfer", args: [POOL, 1000n] });
  await client.call({
    to: TOKEN, data, account: EOA,
    stateOverride: [{ address: TOKEN, stateDiff: { [balSlot]: generousBal } }],
  });
  console.log("  ✓ Random EOA can transfer to pool (NOT a honeypot??)");
} catch (e) { console.log("  ✗ REVERTS — trap triggers on (from!=owner, to=pool)"); console.log("    error:", e.shortMessage?.slice(0, 200)); }
