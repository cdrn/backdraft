import { createPublicClient, http, parseAbi, keccak256 } from "viem";
import { mainnet, base } from "viem/chains";
import fs from "fs";
import "dotenv/config";

const clients = {
  ethereum: createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")) }),
  base: createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_WS.replace("wss://", "https://")) }),
};
const WETH = { ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", base: "0x4200000000000000000000000000000000000006" };

const POOL_ABI = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)"]);
const TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
]);

// 14 confirmed real honeypots from earlier V3 recheck
const honeypots = [
  ["GKOR", "base", "0x640bCe4B059B2D70d1f115B651f9c39B59CfC88a"],
  ["Xvt", "base", "0xA3c1ee252A9A6A999fE79Bc3E75D71FFF586c4Bf"],
  ["Gsfvv", "base", "0x1AFAA66DfE7Dfee6E5857d5FB9B3f0e461cD92e3"],
  ["Ugdbbd", "base", "0x5625cc95F6018ec4808B67F7C641bAdfCDaeAc51"],
  ["Wffs", "base", "0x0618d3576c56DdF25F347fa43d19fdb6739df042"],
  ["Dsdfg", "base", "0x4640fd801E9E900E48a725c215cC4c218bC381C1"],
  ["Rff", "base", "0x641D578710104db388C930F266CD0e8f52e295BE"],
  ["DMD", "base", "0xc46eDE3695561565e30319BB8e5E52A199F02757"],
  ["AFS", "base", "0xA2d0dDCA7003f11D4a18724387F369af198d5AB8"],
  ["zta", "base", "0x2d80302B1CA6727Aabc64c37Fd3e2e825CB382ff"],
  ["GOTCHI", "base", "0xa82ef0D0e5b54e77732127c237942451D93C2BBc"],
  ["asdad", "base", "0xaF7D020dA596227c9633b7624c29933DAA09156D"],
  ["PWEASE", "base", "0x0410352DD81C56E5e0aCb048B0413fE7D0240e6b"],
  ["UCCO", "ethereum", "0xEd374c8D689695866a64d74D82F3b1F75416b31F"],
];

const results = [];
for (const [sym, chain, pool] of honeypots) {
  const client = clients[chain];
  const weth = WETH[chain].toLowerCase();
  try {
    const [t0, t1] = await Promise.all([
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }),
    ]);
    const token = t0.toLowerCase() === weth ? t1 : t0;

    let name = "?", actualSymbol = "?", supply = "?", owner = "<reverts>";
    try { name = await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "name" }); } catch {}
    try { actualSymbol = await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "symbol" }); } catch {}
    try { supply = (await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "totalSupply" })).toString(); } catch {}
    try { owner = await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "owner" }); } catch {}

    const code = await client.getCode({ address: token });
    const bytecodeHash = code ? keccak256(code).slice(0, 18) : "no-code";
    const codeSize = code ? (code.length - 2) / 2 : 0;

    results.push({ sym, chain, token, owner, bytecodeHash, codeSize, name, actualSymbol, supply });
    process.stdout.write(".");
  } catch (e) {
    process.stdout.write("x");
  }
}
console.log("\n");

// Group by bytecode hash
const clusters = new Map();
for (const r of results) {
  if (!clusters.has(r.bytecodeHash)) clusters.set(r.bytecodeHash, []);
  clusters.get(r.bytecodeHash).push(r);
}

console.log("=== 14 CONFIRMED HONEYPOTS — STRUCTURE ===\n");
for (const r of results) {
  console.log(`${r.sym.padEnd(8)} chain=${r.chain.padEnd(8)} owner=${r.owner.slice(0,10)}… code=${r.codeSize}b hash=${r.bytecodeHash}…`);
  console.log(`         token=${r.token}  name="${r.name}"`);
}

console.log("\n=== BYTECODE CLUSTERS ===");
for (const [hash, arr] of [...clusters.entries()].sort((a,b) => b[1].length - a[1].length)) {
  console.log(`\nCluster ${hash}… (${arr.length} tokens, ${arr[0].codeSize}b)`);
  for (const r of arr) console.log(`  ${r.sym.padEnd(8)} owner=${r.owner}  ${r.token}`);
}

// Cluster by owner too
console.log("\n=== OWNER WALLETS ===");
const byOwner = new Map();
for (const r of results) {
  const o = r.owner.toLowerCase();
  if (!byOwner.has(o)) byOwner.set(o, []);
  byOwner.get(o).push(r);
}
for (const [o, arr] of [...byOwner.entries()].sort((a,b) => b[1].length - a[1].length)) {
  console.log(`  ${o} → ${arr.length} tokens: ${arr.map(r => r.sym).join(", ")}`);
}
