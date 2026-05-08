import type { Detector, DetectorContext } from "./types.js";

// EIP-1967 implementation slot
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e0076cc3735a920a3ca505d382bbc" as const;

// EIP-1967 admin slot
const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

// Minimal proxy (EIP-1167) bytecode prefix
const MINIMAL_PROXY_PREFIX = "363d3d373d3d3d363d73";

// Known proxy function selectors
const PROXY_SELECTORS = {
  "5c60da1b": "implementation()",
  "f851a440": "admin()",
  "3659cfe6": "upgradeTo(address)",
  "4f1ef286": "upgradeToAndCall(address,bytes)",
};

export const proxyDetector: Detector = {
  name: "proxy",
  description: "Detects proxy patterns (EIP-1967, EIP-1167, transparent, UUPS)",

  async detect(ctx: DetectorContext) {
    const { contract, client } = ctx;
    const code = contract.bytecode.slice(2);

    // Check for minimal proxy (EIP-1167)
    if (code.startsWith(MINIMAL_PROXY_PREFIX)) {
      const implAddress = "0x" + code.slice(MINIMAL_PROXY_PREFIX.length, MINIMAL_PROXY_PREFIX.length + 40);
      ctx.tags.add("proxy");
      ctx.tags.add("minimal-proxy");
      ctx.meta.proxyType = "EIP-1167";
      ctx.meta.implementationAddress = implAddress;

      ctx.findings.push({
        detector: "proxy",
        severity: "medium",
        title: "Minimal proxy (EIP-1167)",
        description: `Clone proxy pointing to implementation ${implAddress}`,
      });
      return;
    }

    // Check for proxy selectors in bytecode
    const hasProxySelectors = Object.keys(PROXY_SELECTORS).some((sel) =>
      code.includes(sel)
    );

    // Check EIP-1967 storage slots
    let implAddress: string | null = null;
    try {
      const implSlotValue = await client.getStorageAt({
        address: contract.address,
        slot: EIP1967_IMPL_SLOT,
      });

      if (implSlotValue && implSlotValue !== "0x" + "0".repeat(64)) {
        implAddress = "0x" + implSlotValue.slice(26);
        ctx.tags.add("proxy");
        ctx.tags.add("eip-1967");
        ctx.meta.proxyType = "EIP-1967";
        ctx.meta.implementationAddress = implAddress;
      }
    } catch {
      // Storage read failed, skip
    }

    if (implAddress) {
      ctx.findings.push({
        detector: "proxy",
        severity: "medium",
        title: "EIP-1967 proxy detected",
        description: `Implementation at ${implAddress}`,
      });

      // Fetch the implementation bytecode for downstream detectors
      try {
        const implCode = await client.getCode({ address: implAddress as `0x${string}` });
        if (implCode && implCode !== "0x") {
          ctx.meta.implementationBytecode = implCode;
        }
      } catch {
        // Implementation might not exist yet
      }
    } else if (hasProxySelectors) {
      // Has proxy-like selectors but no EIP-1967 slot — could be custom proxy
      ctx.tags.add("proxy-like");
      ctx.findings.push({
        detector: "proxy",
        severity: "low",
        title: "Proxy-like selectors detected",
        description: "Contract has upgrade/implementation selectors but no standard storage layout",
      });
    }
  },
};
