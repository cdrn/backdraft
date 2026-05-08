import { encodeFunctionData, decodeFunctionResult } from "viem";
import type { Detector, DetectorContext } from "./types.js";

// Common initializer selectors
const INITIALIZER_SELECTORS: Record<string, string> = {
  "8129fc1c": "initialize()",
  "c4d66de8": "initialize(address)",
  "485cc955": "initialize(address,address)",
  "f8c8765e": "initialize(address,address,address)",
  "1459457a": "initialize(address,address,address,address)",
  "c0c53b8b": "initialize(address,address,address)", // 3-param variant
  "fe4b84df": "initialize(uint256)",
};

// OZ Initializable._initialized storage slot is typically slot 0 or part of a packed slot
// In OZ v4+, _initialized is a uint8 at a specific slot
// We check the first few storage slots for non-zero values as a heuristic

export const initializerDetector: Detector = {
  name: "initializer",
  description: "Detects uninitialized proxy contracts with callable initialize()",

  async detect(ctx: DetectorContext) {
    // Only care about proxies — skip if proxy detector didn't tag this
    if (!ctx.tags.has("proxy") && !ctx.tags.has("proxy-like")) return;

    const { contract, client } = ctx;

    // Determine which bytecode to scan for initializer selectors
    const targetBytecode =
      (ctx.meta.implementationBytecode as string) || contract.bytecode;
    const code = targetBytecode.slice(2);

    // Find which initializer selectors exist in the bytecode
    const foundSelectors: { selector: string; signature: string }[] = [];
    for (const [selector, signature] of Object.entries(INITIALIZER_SELECTORS)) {
      if (code.includes(selector)) {
        foundSelectors.push({ selector, signature });
      }
    }

    if (foundSelectors.length === 0) return;

    ctx.tags.add("has-initializer");

    // Try calling initialize() to see if it reverts
    // We use eth_call (simulation) — this doesn't submit a real transaction
    for (const { selector, signature } of foundSelectors) {
      try {
        // Build minimal calldata — just the selector padded with zero args
        const argCount = (signature.match(/,/g) || []).length + 1;
        const isNoArg = signature.endsWith("()");
        const calldata = isNoArg
          ? (`0x${selector}` as `0x${string}`)
          : (`0x${selector}${"0".repeat(64 * argCount)}` as `0x${string}`);

        await client.call({
          to: contract.address,
          data: calldata,
        });

        // If we get here without reverting, initialize() is callable
        ctx.findings.push({
          detector: "initializer",
          severity: "critical",
          title: "Uninitialized proxy — initialize() callable",
          description: `${signature} on ${contract.address} did not revert. This proxy may be claimable.`,
        });
        ctx.tags.add("uninitialized");
        ctx.meta.callableInitializer = signature;
        return; // One is enough

      } catch {
        // Reverted — already initialized or access controlled
      }
    }

    // If all reverted, it's initialized or protected
    ctx.findings.push({
      detector: "initializer",
      severity: "low",
      title: "Proxy has initializer (already called or protected)",
      description: `Found ${foundSelectors.map((s) => s.signature).join(", ")} but calls reverted`,
    });
  },
};
