import { keccak256, toHex } from "viem";

const targets = ["918b5be1", "392f37e9", "0e9447d5"];

// Common honeypot/admin function signatures to try
const candidates = [
  "configure(address)", "configure()", "setPair(address)", "setLP(address)",
  "init(address)", "initialize(address)", "setup(address)",
  "setSwapEnabled(bool)", "setLimits(uint256)", "rescue(address)",
  "setAdmin(address)", "setOperator(address)", "withdraw()",
  "withdrawAll()", "drain()", "rescueETH()", "rescueToken(address)",
  "addLiquidity()", "createPair()", "openTrading()",
  "swap()", "execute(bytes)", "call(address,bytes)",
  "burnFrom(address,uint256)", "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "DOMAIN_SEPARATOR()", "nonces(address)", "deposit(uint256)",
  "totalFees()", "swapAndLiquify(uint256)", "manualBurn(uint256)",
  "removeLimits()", "enableTrading(address)", "openTrade(address)",
  "addBlacklist(address)", "removeBlacklist(address)",
];

const hits = {};
for (const sig of candidates) {
  const sel = keccak256(toHex(sig)).slice(2, 10);
  if (targets.includes(sel)) hits[sel] = sig;
}

// Also try some weird ones that look like obfuscated names
const obfuscated = [
  "x(address)", "y(address,uint256)", "z(uint256)",
  "_(address)", "__(address)", "configure(address,uint256)",
  "setRouter(address)", "setExchange(address)", "setMarket(address)",
  "setPool(address)", "registerPool(address)", "linkPool(address)",
  "setSwapPair(address)", "uniswapV2Pair()",
  "lock(uint256)", "lockFor(uint256)",
  "buyback(uint256)", "claim()", "harvest()",
];

for (const sig of obfuscated) {
  const sel = keccak256(toHex(sig)).slice(2, 10);
  if (targets.includes(sel)) hits[sel] = sig;
}

console.log("Resolved:");
for (const [sel, sig] of Object.entries(hits)) {
  console.log(`  0x${sel} → ${sig}`);
}
console.log("\nUnresolved:");
for (const t of targets) {
  if (!hits[t]) console.log(`  0x${t}`);
}
