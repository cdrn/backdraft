import type { Detector, DetectorContext } from "./types.js";

// Function selectors that indicate the contract is worth deeper analysis.
// If none of these are present in bytecode, skip all expensive detectors.
const INTERESTING_SELECTORS: Record<string, string[]> = {
  // Proxy patterns
  proxy: [
    "5c60da1b", // implementation()
    "f851a440", // admin()
    "3659cfe6", // upgradeTo(address)
    "4f1ef286", // upgradeToAndCall(address,bytes)
  ],
  // Withdrawal functions
  withdrawal: [
    "3ccfd60b", // withdraw()
    "2e1a7d4d", // withdraw(uint256)
    "51cff8d9", // withdrawEther(address)
    "db2e21bc", // emergencyWithdraw()
    "853828b6", // drain()
    "e9fad8ee", // exit()
    "4e71d92d", // claim()
  ],
  // Ownership
  ownership: [
    "8da5cb5b", // owner()
    "f2fde38b", // transferOwnership(address)
    "13af4035", // setOwner(address)
    "79ba5097", // claimOwnership()
  ],
  // Initializer
  initializer: [
    "8129fc1c", // initialize()
    "c4d66de8", // initialize(address)
    "485cc955", // initialize(address,address)
    "fe4b84df", // initialize(uint256)
  ],
};

// Minimal proxy (EIP-1167) bytecode prefix — always interesting
const MINIMAL_PROXY_PREFIX = "363d3d373d3d3d363d73";

export const prescreenDetector: Detector = {
  name: "prescreen",
  description: "Fast bytecode scan to decide if expensive detectors should run",

  async detect(ctx: DetectorContext) {
    const code = ctx.contract.bytecode.slice(2);

    // Minimal proxies are always interesting
    if (code.startsWith(MINIMAL_PROXY_PREFIX)) {
      ctx.tags.add("prescreen-proxy");
      ctx.tags.add("prescreen-initializer");
      return;
    }

    // Check for interesting selectors
    for (const [category, selectors] of Object.entries(INTERESTING_SELECTORS)) {
      for (const selector of selectors) {
        if (code.includes(selector)) {
          ctx.tags.add(`prescreen-${category}`);
          break;
        }
      }
    }
  },
};
