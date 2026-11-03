// Seismograph entrypoint — runs every observatory in ONE process / container:
//   delta   stablecoin cross-chain basis        :4747
//   funding cross-venue perp funding basis      :4748
//   spread  CEX↔DEX realizable spread           :4749
// They share nothing but the poll-and-store pattern; each keeps its own
// SQLite DB and HTTP port. One container because all three are calm poll
// loops on the same image that redeploy together.

import "dotenv/config";

import { startCollector as startDeltaCollector } from "./delta/collector.js";
import { startServer as startDeltaServer } from "./delta/server.js";
import { Store as DeltaStore } from "./delta/store.js";
import { DB_PATH as DELTA_DB_PATH } from "./delta/config.js";

import { startCollector as startFundingCollector } from "./funding/collector.js";
import { startServer as startFundingServer } from "./funding/server.js";
import { Store as FundingStore } from "./funding/store.js";
import { FUNDING_DB_PATH } from "./funding/config.js";

import { startCollector as startSpreadCollector } from "./spread/collector.js";
import { startServer as startSpreadServer } from "./spread/server.js";
import { Store as SpreadStore } from "./spread/store.js";
import { DB_PATH as SPREAD_DB_PATH } from "./spread/config.js";

const enabled = (name: string) => (process.env[`ENABLE_${name.toUpperCase()}`] ?? "true") !== "false";

console.log("Backdraft Seismographs — delta + funding + spread\n");

if (enabled("delta")) {
  const delta = new DeltaStore(DELTA_DB_PATH);
  startDeltaCollector(delta);
  startDeltaServer(delta);
}

if (enabled("funding")) {
  const funding = new FundingStore(FUNDING_DB_PATH);
  startFundingCollector(funding);
  startFundingServer(funding);
}

if (enabled("spread")) {
  const spread = new SpreadStore(SPREAD_DB_PATH);
  const collector = startSpreadCollector(spread);
  startSpreadServer(spread, collector);
}
