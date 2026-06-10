import { createPublicClient, http, parseAbi, keccak256, toHex } from "viem";
import { base } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) });

const IMPL = "0x2BB625DAa0A9dD2C69939cBD6c2dBae2ac6667AC";
const code = await client.getCode({ address: IMPL });
const hex = code.slice(2).toLowerCase();
console.log(`Impl size: ${hex.length / 2} bytes\n`);

// Extract function selectors from dispatch table — pattern: 63 XX XX XX XX 14 (PUSH4 selector EQ)
const selectors = new Set();
for (let i = 0; i < hex.length - 12; i += 2) {
  if (hex.slice(i, i + 2) === "63" && hex.slice(i + 10, i + 12) === "14") {
    selectors.add(hex.slice(i + 2, i + 10));
  }
}

const known = {
  "a9059cbb": "transfer(address,uint256)",
  "23b872dd": "transferFrom(address,address,uint256)",
  "dd62ed3e": "allowance(address,address)",
  "095ea7b3": "approve(address,uint256)",
  "06fdde03": "name()",
  "95d89b41": "symbol()",
  "18160ddd": "totalSupply()",
  "70a08231": "balanceOf(address)",
  "313ce567": "decimals()",
  "8da5cb5b": "owner()",
  "f2fde38b": "transferOwnership(address)",
  "715018a6": "renounceOwnership()",
  "40c10f19": "mint(address,uint256)",
  "42966c68": "burn(uint256)",
  "79cc6790": "burnFrom(address,uint256)",
  "39509351": "increaseAllowance(address,uint256)",
  "a457c2d7": "decreaseAllowance(address,uint256)",
};

console.log("=== ALL SELECTORS ===");
const unknown = [];
for (const s of [...selectors].sort()) {
  if (known[s]) console.log(`  0x${s} ${known[s]}`);
  else { console.log(`  0x${s} ???`); unknown.push(s); }
}

// Brute-force common honeypot-y function name candidates
console.log("\n=== BRUTE-FORCE UNKNOWN SELECTORS ===");
const candidates = [
  "initialize(string,string,uint8,uint256,address)",
  "initialize(string,string,uint256,address)",
  "initialize(string,string,uint256)",
  "initialize(address)",
  "init(string,string,uint256,address)",
  "init(address,string,string,uint256)",
  "init()",
  "configure(address)",
  "setPair(address)",
  "setLP(address)",
  "addLiquidityETH()",
  "addLiquidity()",
  "execute(bytes)",
  "execute()",
  "trade(address,uint256)",
  "openTrading(address)",
  "rescue()",
  "rescueETH()",
  "rescueTokens()",
  "rescueToken(address)",
  "rescueTokens(address)",
  "withdraw()",
  "withdrawAll()",
  "withdrawETH()",
  "claim()",
  "harvest()",
  "drain()",
  "skim()",
  "sync()",
  "setBlacklist(address,bool)",
  "setWhitelist(address,bool)",
  "addToWhitelist(address)",
  "removeFromWhitelist(address)",
  "setWhitelisted(address,bool)",
  "isWhitelisted(address)",
  "whitelist(address)",
  "whitelisted(address)",
  "setExempt(address,bool)",
  "setOperator(address,bool)",
  "setOperator(address)",
  "lock(address,uint256)",
  "unlock(address)",
  "setMaxAmount(uint256)",
  "setLimit(uint256)",
  "x(address)",
  "y(address)",
  "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "DOMAIN_SEPARATOR()",
  "nonces(address)",
  "version()",
  "setVerified(bool)",
  "metadata()",
  "updateMetadata(string)",
];
const found = {};
for (const sig of candidates) {
  const sel = keccak256(toHex(sig)).slice(2, 10);
  if (unknown.includes(sel)) found[sel] = sig;
}
for (const [sel, sig] of Object.entries(found)) console.log(`  0x${sel} ${sig}`);
const stillUnknown = unknown.filter(s => !found[s]);
console.log("\nStill unresolved:", stillUnknown.map(s => "0x" + s).join(", "));

// Search bytecode for hardcoded addresses (router, weth, factory, etc.)
const WETH = "4200000000000000000000000000000000000006";
const V2_ROUTER = "4752ba5dbc23f44d87826276bf6fd6b1c372ad24";
const V2_FACTORY = "8909dc15e40173ff4699343b6eb8132c65e18ec6";
const V3_FACTORY = "33128a8fc17869897dce68ed026d694621f6fdfd";
const SWAP_ROUTER = "2626664c2603336e57b271c5c0b26f421741e481"; // Uniswap V3 SwapRouter on Base
const UNIVERSAL_ROUTER = "3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad";
const POS_MANAGER = "03a520b32c04bf3beef7beb72e919cf822ed34f1";

console.log("\n=== HARDCODED ADDRESSES IN BYTECODE ===");
for (const [name, addr] of [["WETH", WETH], ["V2 router", V2_ROUTER], ["V2 factory", V2_FACTORY], ["V3 factory", V3_FACTORY], ["V3 SwapRouter02", SWAP_ROUTER], ["Universal Router", UNIVERSAL_ROUTER], ["V3 PositionManager", POS_MANAGER]]) {
  if (hex.includes(addr)) console.log(`  ✓ ${name} (${addr})`);
}

// Search for revert strings
console.log("\n=== REVERT STRINGS ===");
const stringMatches = hex.match(/[a-f0-9]{40,}/g) || [];
// 0x08c379a0 = Error(string) selector
const errIdx = hex.indexOf("08c379a0");
if (errIdx >= 0) console.log(`  Error(string) selector found at offset ${errIdx/2}`);
// Find ASCII-looking strings
let strs = [];
for (let i = 0; i < hex.length - 60; i += 2) {
  let ok = true, s = "";
  for (let j = 0; j < 60 && i + j < hex.length; j += 2) {
    const c = parseInt(hex.slice(i+j, i+j+2), 16);
    if (c >= 32 && c < 127) s += String.fromCharCode(c);
    else { ok = false; break; }
  }
  if (s.length > 6 && /^[a-zA-Z0-9 :_!]+$/.test(s)) {
    strs.push(s);
    i += s.length * 2;
  }
}
for (const s of [...new Set(strs)].filter(s => s.length > 6).slice(0, 30)) {
  console.log(`  "${s}"`);
}
