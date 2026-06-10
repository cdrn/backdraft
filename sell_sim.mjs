import { createPublicClient, http, parseAbi, parseEther, encodeFunctionData } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")),
});

const ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uni V2
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const HANTA = "0xb5295b5a763D27feA998E29e90349B9aD42c371E";
const HANTA_POOL = "0xF6B5a2041643A87244f83C1384C39a17b05a3f3A";

// Pretend victim address
const VICTIM = "0x0000000000000000000000000000000000001337";

const ROUTER_ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
]);

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

console.log("=== STEP 1: getAmountsOut (what most bots check) ===");
try {
  const buyOut = await client.readContract({
    address: ROUTER, abi: ROUTER_ABI, functionName: "getAmountsOut",
    args: [parseEther("0.01"), [WETH, HANTA]],
  });
  console.log("  Buy 0.01 WETH → HANTA:", buyOut[1].toString(), "tokens out");

  const sellOut = await client.readContract({
    address: ROUTER, abi: ROUTER_ABI, functionName: "getAmountsOut",
    args: [buyOut[1], [HANTA, WETH]],
  });
  console.log("  Sell those tokens → WETH:", sellOut[1].toString(), "wei out");
  console.log("  ✓ AMM math says you'd get your WETH back");
} catch (e) {
  console.log("  ✗ getAmountsOut reverted:", e.shortMessage);
}

console.log("\n=== STEP 2: Real eth_call buy simulation (with state override) ===");
try {
  const buyData = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "swapExactETHForTokens",
    args: [0n, [WETH, HANTA], VICTIM, 9999999999n],
  });
  await client.call({
    to: ROUTER, data: buyData, value: parseEther("0.01"), account: VICTIM,
  });
  console.log("  ✓ Buy succeeds");
} catch (e) {
  console.log("  ✗ Buy reverts:", e.shortMessage?.slice(0, 200));
}

console.log("\n=== STEP 3: Real sell simulation (the moment of truth) ===");
// Pretend victim already holds 1 token. Use state override.
try {
  const sellData = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "swapExactTokensForETH",
    args: [parseEther("100"), 0n, [HANTA, WETH], VICTIM, 9999999999n],
  });

  // Need to override victim's HANTA balance + allowance for router
  // Storage slots vary per token. We'll just set a generous balance assuming slot 0.
  const balanceSlot = `0x${"0".padStart(64, "0")}`;

  await client.call({
    to: ROUTER, data: sellData, account: VICTIM,
    stateOverride: [
      {
        address: HANTA,
        // override balanceOf(VICTIM) — typically slot 0 for OZ ERC20, computed as keccak(victim, 0)
        // Simpler: override storage that affects balance. We'll use stateDiff with a brute slot search.
      }
    ]
  });
  console.log("  ✓ Sell succeeds (NOT a honeypot)");
} catch (e) {
  console.log("  ✗ Sell reverts:", e.shortMessage?.slice(0, 300));
  console.log("\n  Cause:", e.cause?.message?.slice(0, 200) || e.message?.slice(0, 200));
}

// Better approach: use trace_call to actually execute and find the revert point
// For now, simpler: have the pool transfer tokens to victim first, then victim sells

console.log("\n=== STEP 4: Buy then sell in one simulation ===");
// We can't easily chain in a single eth_call, but we can ask the pool to send us tokens
// via a different path. Let's just check what happens if VICTIM tries swapTokensForETH
// after we override their balance properly.

// Let's try with state override using the standard OZ balance slot
// For OpenZeppelin ERC20, balances mapping is at slot 0
import { encodeAbiParameters, keccak256 } from "viem";
const slot = keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "uint256" }],
  [VICTIM, 0n]
));

// Allowance mapping is at slot 1
const allowanceSlot = keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "uint256" }],
  [VICTIM, 1n]
));
const finalAllowanceSlot = keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "bytes32" }],
  [ROUTER, allowanceSlot]
));

try {
  const sellData = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "swapExactTokensForETH",
    args: [parseEther("100"), 0n, [HANTA, WETH], VICTIM, 9999999999n],
  });

  await client.call({
    to: ROUTER, data: sellData, account: VICTIM,
    stateOverride: [{
      address: HANTA,
      stateDiff: {
        [slot]: `0x${(parseEther("1000")).toString(16).padStart(64, "0")}`,
        [finalAllowanceSlot]: `0x${(parseEther("10000")).toString(16).padStart(64, "0")}`,
      }
    }]
  });
  console.log("  ✓ Sell with overridden balance/allowance succeeds (NOT honeypot)");
} catch (e) {
  console.log("  ✗ SELL REVERTS:", e.shortMessage?.slice(0, 300));
  if (e.cause) console.log("  cause:", e.cause.message?.slice(0, 200));
}
