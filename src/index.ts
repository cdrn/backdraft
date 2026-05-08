import "dotenv/config";
import { createPublicClient, webSocket, type Chain } from "viem";
import { mainnet, arbitrum, base } from "viem/chains";
import { DeploymentListener } from "./listener/deployment-listener.js";
import {
  Pipeline,
  formatResult,
  proxyDetector,
  initializerDetector,
  openWithdrawalDetector,
  ownershipDetector,
} from "./detectors/index.js";
import { Store } from "./store/index.js";
import { Executor } from "./executor/index.js";

interface ChainConfig {
  chain: Chain;
  envKey: string;
  name: string;
}

const CHAINS: ChainConfig[] = [
  { chain: mainnet, envKey: "ETH_RPC_WS", name: "ethereum" },
  { chain: arbitrum, envKey: "ARB_RPC_WS", name: "arbitrum" },
  { chain: base, envKey: "BASE_RPC_WS", name: "base" },
];

const SCORE_THRESHOLD = 30;
const EXECUTE_THRESHOLD = 50; // only auto-execute on high-confidence findings

async function main() {
  console.log("Sentinel - Contract Deployment Scanner");
  console.log("=======================================\n");

  const store = new Store();
  console.log("Database: sentinel.db\n");

  // Build the detector pipeline
  const pipeline = new Pipeline();
  console.log("Loading detectors:");
  pipeline.register(proxyDetector);
  pipeline.register(initializerDetector);
  pipeline.register(openWithdrawalDetector);
  pipeline.register(ownershipDetector);
  console.log("");

  // Executor
  console.log("Executor:");
  const executor = new Executor();
  console.log("");

  let totalScanned = 0;
  let totalFlagged = 0;
  let totalExecuted = 0;

  const listeners: DeploymentListener[] = [];

  for (const { chain, envKey, name } of CHAINS) {
    const rpcUrl = process.env[envKey];
    if (!rpcUrl) {
      console.log(`Skipping ${name} — ${envKey} not set`);
      continue;
    }

    const client = createPublicClient({
      chain,
      transport: webSocket(rpcUrl),
    });

    const listener = new DeploymentListener(client, name);

    listener.onDeploy(async (contract) => {
      const result = await pipeline.run(contract, client);
      totalScanned++;

      // Persist everything that has findings
      let contractId = 0;
      if (result.findings.length > 0) {
        contractId = store.save(result);
      }

      if (result.score >= SCORE_THRESHOLD) {
        totalFlagged++;
        console.log(formatResult(result));
      }

      // Execute on critical findings
      if (result.score >= EXECUTE_THRESHOLD && result.findings.some(f => f.severity === "critical")) {
        const execResults = await executor.execute(result, client);
        totalExecuted += execResults.length;

        // Persist execution results
        if (contractId > 0) {
          for (const exec of execResults) {
            store.saveExecution(contractId, exec);
          }
        }
      }
    });

    listeners.push(listener);
  }

  if (listeners.length === 0) {
    console.error("No RPC endpoints configured. Copy .env.example to .env and add your keys.");
    process.exit(1);
  }

  await Promise.all(listeners.map((l) => l.start()));

  // Print stats periodically
  setInterval(() => {
    console.log(`\n--- Scanned: ${totalScanned} | Flagged: ${totalFlagged} | Executed: ${totalExecuted} ---\n`);
  }, 60_000);

  process.on("SIGINT", () => {
    console.log(`\nShutting down... Scanned ${totalScanned}, flagged ${totalFlagged}, executed ${totalExecuted}.`);
    const stats = store.getStats();
    if (stats.length > 0) {
      console.log("\nSession stats by chain:");
      console.table(stats);
    }
    store.close();
    listeners.forEach((l) => l.stop());
    process.exit(0);
  });
}

main().catch(console.error);
