import { createPublicClient, http, parseAbi, parseEther, encodeFunctionData, encodeAbiParameters, keccak256, formatEther, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")),
});

const ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const TOKEN = "0xb5295b5a763D27feA998E29e90349B9aD42c371E"; // HANTA
const POOL = "0xF6B5a2041643A87244f83C1384C39a17b05a3f3A";
const VICTIM = "0x000000000000000000000000000000000000bEEF";

const PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
]);
const ROUTER_ABI = parseAbi([
  "function swapExactETHForTokens(uint256, address[], address, uint256) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256, uint256, address[], address, uint256) returns (uint256[])",
  "function getAmountsOut(uint256, address[]) view returns (uint256[])",
]);

console.log("=== Pool reserves ===");
const [r0, r1] = await client.readContract({ address: POOL, abi: PAIR_ABI, functionName: "getReserves" });
const token0 = await client.readContract({ address: POOL, abi: PAIR_ABI, functionName: "token0" });
const wethIsToken0 = token0.toLowerCase() === WETH.toLowerCase();
console.log(`  WETH reserve: ${formatEther(wethIsToken0 ? r0 : r1)} ETH`);
console.log(`  HANTA reserve: ${formatUnits(wethIsToken0 ? r1 : r0, 18)} tokens`);

console.log("\n=== Buy simulation (eth_call against router) ===");
try {
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "swapExactETHForTokens",
    args: [0n, [WETH, TOKEN], VICTIM, BigInt(Math.floor(Date.now()/1000) + 3600)],
  });
  const result = await client.call({
    to: ROUTER, data, value: parseEther("0.0001"), account: VICTIM,
  });
  console.log("  ✓ Buy SUCCEEDS — bot sees this and apes in");
} catch (e) {
  console.log("  ✗ Buy reverts:", e.shortMessage?.slice(0, 200));
}

console.log("\n=== Sell simulation (with state override to give victim tokens) ===");
// OZ ERC20 balances mapping is at slot 0: balances[victim] = keccak(abi.encode(victim, 0))
const balSlot = keccak256(encodeAbiParameters([{type:"address"}, {type:"uint256"}], [VICTIM, 0n]));
// allowances[victim][router] = keccak(abi.encode(router, keccak(abi.encode(victim, 1))))
const allowanceInner = keccak256(encodeAbiParameters([{type:"address"}, {type:"uint256"}], [VICTIM, 1n]));
const allowanceSlot = keccak256(encodeAbiParameters([{type:"address"}, {type:"bytes32"}], [ROUTER, allowanceInner]));

const generousBalance = ("0x" + (10n ** 21n).toString(16).padStart(64, "0"));
const generousAllowance = ("0x" + (10n ** 30n).toString(16).padStart(64, "0"));

try {
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "swapExactTokensForETH",
    args: [parseEther("100"), 0n, [TOKEN, WETH], VICTIM, BigInt(Math.floor(Date.now()/1000) + 3600)],
  });
  await client.call({
    to: ROUTER, data, account: VICTIM,
    stateOverride: [{
      address: TOKEN,
      stateDiff: {
        [balSlot]: generousBalance,
        [allowanceSlot]: generousAllowance,
      }
    }]
  });
  console.log("  ✓ Sell succeeds — NOT a honeypot");
} catch (e) {
  console.log("  ✗ SELL REVERTS — this is the trap firing");
  console.log("    Error:", e.shortMessage?.slice(0, 200));
  // dig into the revert reason
  const msg = e.message || "";
  const match = msg.match(/revert(?:ed)?[^"]*"([^"]+)"/);
  if (match) console.log("    Reason:", match[1]);
  if (msg.includes("TRANSFER_FROM_FAILED")) console.log("    → Router got TRANSFER_FROM_FAILED — the token's transfer/transferFrom is rejecting");
  if (msg.includes("INSUFFICIENT")) console.log("    → AMM math issue");
}
