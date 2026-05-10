function flag(key: string, defaultValue = true): boolean {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  return val === "true" || val === "1";
}

// Master killswitch — when true, the app starts up but no listeners or
// executors run. Useful for keeping the container alive while halting
// all on-chain activity.
const killswitch = flag("KILLSWITCH", false);

export const flags = {
  killswitch,

  // Listeners
  deploymentListener: !killswitch && flag("ENABLE_DEPLOYMENT_LISTENER", true),
  factoryListener: !killswitch && flag("ENABLE_FACTORY_LISTENER", true),

  // Detector groups
  vulnDetectors: !killswitch && flag("ENABLE_VULN_DETECTORS", true),
  sniper: !killswitch && flag("ENABLE_SNIPER", true),

  // Arb
  arbScanner: !killswitch && flag("ENABLE_ARB_SCANNER", true),

  // Execution
  executor: !killswitch && flag("ENABLE_EXECUTOR", true),
};

export function printFlags() {
  console.log("Feature flags:");
  for (const [key, val] of Object.entries(flags)) {
    console.log(`  ${key}: ${val ? "ON" : "OFF"}`);
  }
  console.log("");
}
