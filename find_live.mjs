import { createPublicClient, http, parseAbi, formatEther } from "viem";
import { mainnet, base } from "viem/chains";
import fs from "fs";
import "dotenv/config";

const clients = {
  ethereum: createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")) }),
  base: createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) }),
};
const WETH = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  base: "0x4200000000000000000000000000000000000006",
};

const lines = fs.readFileSync("/Users/cdrn/Code/backdraft/honeypots.txt", "utf8").trim().split("\n");

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const PAIR = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)"]);

const live = [];
for (const line of lines) {
  const [pool, chain, symbol] = line.split("|");
  try {
    const bal = await clients[chain].readContract({
      address: WETH[chain], abi: ERC20, functionName: "balanceOf", args: [pool],
    });
    if (bal > 0n) {
      live.push({ pool, chain, symbol, wethBal: parseFloat(formatEther(bal)) });
    }
  } catch {}
}

live.sort((a, b) => b.wethBal - a.wethBal);
console.log("Pools with WETH still in them (trap still live):\n");
for (const p of live) {
  console.log(`  ${p.symbol.padEnd(12)} ${p.chain.padEnd(9)} ${p.wethBal.toFixed(6)} WETH  ${p.pool}`);
}
