import type { PublicClient, Chain, Transport } from "viem";
import type { DeployedContract } from "../listener/deployment-listener.js";
import type { Detector, DetectorContext, Finding } from "./types.js";

export interface PipelineResult {
  contract: DeployedContract;
  findings: Finding[];
  tags: Set<string>;
  meta: Record<string, unknown>;
  score: number;
}

const SEVERITY_SCORES: Record<Finding["severity"], number> = {
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
};

export class Pipeline {
  private cheapDetectors: Detector[] = [];
  private expensiveDetectors: Detector[] = [];

  /**
   * Register a detector.
   * @param expensive - If true, only runs when cheap detectors found something
   *                    or the contract is a new pool. Saves RPC calls.
   */
  register(detector: Detector, expensive = false) {
    if (expensive) {
      this.expensiveDetectors.push(detector);
    } else {
      this.cheapDetectors.push(detector);
    }
    console.log(`  Registered detector: ${detector.name}${expensive ? " (gated)" : ""}`);
  }

  async run(
    contract: DeployedContract,
    client: PublicClient<Transport, Chain>
  ): Promise<PipelineResult> {
    const ctx: DetectorContext = {
      contract,
      client,
      findings: [],
      tags: new Set(),
      meta: {},
    };

    // Phase 1: cheap detectors (bytecode-only, minimal RPC)
    for (const detector of this.cheapDetectors) {
      try {
        await detector.detect(ctx);
      } catch (err) {
        console.error(`[${detector.name}] Error on ${contract.address}:`, err);
      }
    }

    // Phase 2: expensive detectors — only if phase 1 found something
    // or if this is a factory-created pool (always worth checking)
    const shouldRunExpensive = ctx.findings.length > 0
      || ctx.tags.size > 0
      || contract.poolInfo !== undefined;

    if (shouldRunExpensive) {
      for (const detector of this.expensiveDetectors) {
        try {
          await detector.detect(ctx);
        } catch (err) {
          console.error(`[${detector.name}] Error on ${contract.address}:`, err);
        }
      }
    }

    const score = Math.min(
      100,
      ctx.findings.reduce((sum, f) => sum + SEVERITY_SCORES[f.severity], 0)
    );

    return {
      contract,
      findings: ctx.findings,
      tags: ctx.tags,
      meta: ctx.meta,
      score,
    };
  }
}

export function formatResult(result: PipelineResult): string {
  const { contract, findings, tags, score } = result;
  const size = (contract.bytecode.length - 2) / 2;

  const lines = [
    `\n${"=".repeat(60)}`,
    `Contract: ${contract.address}`,
    `Chain:    ${contract.chain}`,
    `Deployer: ${contract.deployer}`,
    `Tx:       ${contract.txHash}`,
    `Size:     ${size} bytes`,
    `Score:    ${score}/100`,
    `Tags:     ${[...tags].join(", ") || "none"}`,
    ``,
  ];

  if (findings.length > 0) {
    lines.push("Findings:");
    for (const f of findings) {
      lines.push(`  [${f.severity.toUpperCase()}] ${f.detector} → ${f.title}`);
      lines.push(`    ${f.description}`);
    }
  }

  lines.push("=".repeat(60));
  return lines.join("\n");
}
