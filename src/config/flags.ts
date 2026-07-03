function flag(key: string, defaultValue = true): boolean {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  return val === "true" || val === "1";
}

// Master killswitch — when true, the app starts up but no listeners or
// executors run. Useful for keeping the container alive while halting
// all on-chain activity.
const killswitch = flag("KILLSWITCH", false);

// Comma-separated chain allowlist. Empty string = no chains.
function chainSet(key: string, defaultChains: string): Set<string> {
  const raw = process.env[key] ?? defaultChains;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

// The deployment listener fetches every block's full tx set (the dominant
// Alchemy CU sink) and cost scales with block rate — Arbitrum's ~4 blocks/s
// makes it the single most expensive chain, so it's dropped by default.
// The factory listener is a cheap log subscription, so it defaults to all.
const deploymentChains = killswitch
  ? new Set<string>()
  : chainSet("DEPLOYMENT_CHAINS", "ethereum,base");
const factoryChains = killswitch
  ? new Set<string>()
  : chainSet("FACTORY_CHAINS", "ethereum,arbitrum,base");

export const flags = {
  killswitch,

  // Listeners (master gates)
  deploymentListener: !killswitch && flag("ENABLE_DEPLOYMENT_LISTENER", true),
  factoryListener: !killswitch && flag("ENABLE_FACTORY_LISTENER", true),

  // Per-chain listener allowlists (checked in addition to the master gate)
  deploymentChains,
  factoryChains,

  // Detector groups
  vulnDetectors: !killswitch && flag("ENABLE_VULN_DETECTORS", true),
  sniper: !killswitch && flag("ENABLE_SNIPER", true),

  // Arb — off by default. Forensics (34h, 0 spreads >5bps, non-competitive
  // with mempool searchers) showed the 2s poll burns ~34M CU/day for nothing.
  arbScanner: !killswitch && flag("ENABLE_ARB_SCANNER", false),

  // Execution
  executor: !killswitch && flag("ENABLE_EXECUTOR", true),
};

export function printFlags() {
  console.log("Feature flags:");
  for (const [key, val] of Object.entries(flags)) {
    const shown =
      val instanceof Set ? `[${[...val].join(", ") || "none"}]` : val ? "ON" : "OFF";
    console.log(`  ${key}: ${shown}`);
  }
  console.log("");
}
