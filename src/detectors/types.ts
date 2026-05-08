import type { PublicClient, Chain, Transport } from "viem";
import type { DeployedContract } from "../listener/deployment-listener.js";

export type Severity = "low" | "medium" | "high" | "critical";

export interface Finding {
  detector: string;
  severity: Severity;
  title: string;
  description: string;
}

export interface DetectorContext {
  contract: DeployedContract;
  client: PublicClient<Transport, Chain>;
  findings: Finding[];
  tags: Set<string>; // e.g. "proxy", "token", "has-initializer"
  meta: Record<string, unknown>; // detectors can stash data for downstream use
}

export interface Detector {
  name: string;
  description: string;
  detect(ctx: DetectorContext): Promise<void>;
}
