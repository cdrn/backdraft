import type { Detector, DetectorContext } from "./types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Selectors that return an address we can check
const OWNERSHIP_SELECTORS: Record<string, string> = {
  "8da5cb5b": "owner()",
  "f851a440": "admin()",
  "5aa6e675": "governance()",
  "0c340a24": "governance()", // alt
  "f39c38a0": "pendingGovernance()",
  "e30c3978": "pendingOwner()",
};

// Functions that could let us claim ownership if owner is zero
const CLAIM_SELECTORS: Record<string, string> = {
  "f2fde38b": "transferOwnership(address)",
  "13af4035": "setOwner(address)",
  "b2bdfa7b": "setOwner(address)", // alt
  "ab033ea9": "setGovernance(address)",
  "cfad57a2": "setAdmin(address)",
  "79ba5097": "claimOwnership()",
  "e30c3978": "acceptOwnership()",
};

export const ownershipDetector: Detector = {
  name: "ownership",
  description: "Detects contracts with unclaimed or zero-address ownership",

  async detect(ctx: DetectorContext) {
    const { contract, client } = ctx;
    const code = contract.bytecode.slice(2);

    // Check which ownership-returning functions exist
    for (const [selector, signature] of Object.entries(OWNERSHIP_SELECTORS)) {
      if (!code.includes(selector)) continue;

      try {
        const result = await client.call({
          to: contract.address,
          data: `0x${selector}` as `0x${string}`,
        });

        if (!result.data) continue;

        // Decode the returned address (last 40 hex chars of the 32-byte word)
        const returnedAddress = "0x" + result.data.slice(26).toLowerCase();

        if (returnedAddress === ZERO_ADDRESS) {
          ctx.tags.add("zero-owner");

          // Now check if we can claim it
          for (const [claimSel, claimSig] of Object.entries(CLAIM_SELECTORS)) {
            if (!code.includes(claimSel)) continue;

            // Simulate calling the claim function with our address as arg
            const calldata = claimSig.endsWith("()")
              ? (`0x${claimSel}` as `0x${string}`)
              : (`0x${claimSel}${"0".repeat(24)}0000000000000000000000000000000000000001` as `0x${string}`);

            try {
              await client.call({
                to: contract.address,
                data: calldata,
                account: "0x0000000000000000000000000000000000000001",
              });

              // Didn't revert — ownership is claimable
              ctx.findings.push({
                detector: "ownership",
                severity: "critical",
                title: `Claimable ownership via ${claimSig}`,
                description: `${signature} returns zero address and ${claimSig} is callable. Ownership can be taken.`,
              });
              ctx.tags.add("claimable-ownership");
              ctx.meta.claimFunction = claimSig;
              return;

            } catch {
              // Reverted — claim function is protected some other way
            }
          }

          // Owner is zero but no claim function works
          ctx.findings.push({
            detector: "ownership",
            severity: "medium",
            title: `${signature} returns zero address`,
            description: "Owner is unset but no open claim function found. May be intentional (renounced).",
          });
        }
      } catch {
        // Call failed
      }
    }
  },
};
