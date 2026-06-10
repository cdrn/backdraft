import { createPublicClient, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import "dotenv/config";

const client = createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_WS.replace("wss://", "https://")) });

const ADDR = "0xF6B5a2041643A87244f83C1384C39a17b05a3f3A";

const code = await client.getCode({ address: ADDR });
console.log(`Code at ${ADDR}:`);
console.log(`  size: ${(code.length - 2) / 2} bytes`);
console.log(`  bytecode: ${code.slice(0, 200)}...`);

// Check the V2 factory's getPair to confirm what is the real pair
const V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const HANTA = "0xb5295b5a763D27feA998E29e90349B9aD42c371E";

const realPair = await client.readContract({
  address: V2_FACTORY,
  abi: parseAbi(["function getPair(address, address) view returns (address)"]),
  functionName: "getPair",
  args: [HANTA, WETH],
});
console.log(`\nReal V2 pair for HANTA/WETH: ${realPair}`);
console.log(`Address we had stored: ${ADDR}`);
console.log(`Match: ${realPair.toLowerCase() === ADDR.toLowerCase()}`);

// Check if maybe this address is on V3
const V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
for (const fee of [100, 500, 3000, 10000]) {
  const v3pool = await client.readContract({
    address: V3_FACTORY,
    abi: parseAbi(["function getPool(address, address, uint24) view returns (address)"]),
    functionName: "getPool",
    args: [HANTA, WETH, fee],
  });
  if (v3pool !== "0x0000000000000000000000000000000000000000") {
    console.log(`V3 pool fee=${fee}: ${v3pool}`);
  }
}
