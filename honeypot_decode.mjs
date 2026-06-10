import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")),
});

// Take the most-replicated cluster member
const TOKEN = "0xb5295b5a763D27feA998E29e90349B9aD42c371E"; // HANTA

const code = await client.getCode({ address: TOKEN });
const hex = code.slice(2);

// Extract function selectors via PUSH4 patterns (63...) — rough, but works
// Each "63XXXXXXXX" in the dispatch table is a selector
const selectors = new Set();
for (let i = 0; i < hex.length - 10; i += 2) {
  if (hex.slice(i, i+2) === "63") {
    const sel = hex.slice(i+2, i+10);
    // selectors are typically followed by EQ (14)
    if (hex.slice(i+10, i+12) === "14") {
      selectors.add(sel);
    }
  }
}

const known = {
  "06fdde03": "name()",
  "095ea7b3": "approve(address,uint256)",
  "18160ddd": "totalSupply()",
  "23b872dd": "transferFrom(address,address,uint256)",
  "313ce567": "decimals()",
  "70a08231": "balanceOf(address)",
  "8da5cb5b": "owner()",
  "95d89b41": "symbol()",
  "a9059cbb": "transfer(address,uint256)",
  "dd62ed3e": "allowance(address,address)",
  "f2fde38b": "transferOwnership(address)",
  "715018a6": "renounceOwnership()",
};

const susBlacklist = {
  "49bd5a5e": "uniswapV2Pair", "c9567bf9": "openTrading", "8f70ccf7": "setTradingOpen",
  "e01af92c": "setAntiBot", "2b14ca56": "sellFee", "1694505e": "setUniswapRouter",
  "bbc0c742": "tradingOpen", "b515566a": "addBots", "d5d7bc17": "addBot",
  "3fc8cef3": "delBots", "b87f137a": "isBot", "bf474bed": "reduceFee",
  "4f7041a5": "setFee", "a5ece941": "setFeeAddress", "a9e282b8": "setBlacklist",
  "51bc3c85": "manualSwap", "c3c8cd80": "manualSend", "74010ece": "setMaxTxAmount",
};

console.log("=== HANTA bytecode analysis ===");
console.log(`Size: ${hex.length / 2} bytes`);
console.log(`Selectors found: ${selectors.size}\n`);

console.log("Standard ERC20 / Ownable:");
for (const sel of selectors) {
  if (known[sel]) console.log(`  ${sel} → ${known[sel]}`);
}
console.log("\nKnown-suspicious selectors:");
let foundSus = 0;
for (const sel of selectors) {
  if (susBlacklist[sel]) { console.log(`  ${sel} → ${susBlacklist[sel]} ⚠️`); foundSus++; }
}
if (foundSus === 0) console.log("  NONE — passes our selector scan");

console.log("\nUnknown selectors (could be the trap config):");
for (const sel of selectors) {
  if (!known[sel] && !susBlacklist[sel]) console.log(`  0x${sel}`);
}

// Look for the WETH/router/pair address baked into the constructor or initializer
const WETH_ETH = "c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ROUTER_V2 = "7a250d5630b4cf539739df2c5dacb4c659f2488d";
const FACTORY_V2 = "5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";

console.log("\nHardcoded addresses in bytecode:");
if (hex.toLowerCase().includes(WETH_ETH)) console.log("  WETH ✓");
if (hex.toLowerCase().includes(ROUTER_V2)) console.log("  Uniswap V2 Router ✓");
if (hex.toLowerCase().includes(FACTORY_V2)) console.log("  Uniswap V2 Factory ✓");
