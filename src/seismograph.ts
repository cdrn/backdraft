// Combined seismograph entrypoint — runs both the delta (stablecoin
// venue-basis) and funding (cross-venue perp funding-basis) observatories in
// ONE process / container. They share nothing but the poll-and-store pattern;
// each keeps its own SQLite DB and HTTP port (delta :4747, funding :4748).
// One container because both are calm poll loops on the same image that
// redeploy together — a second container would buy nothing.

import "dotenv/config";

import { startCollector as startDeltaCollector } from "./delta/collector.js";
import { startServer as startDeltaServer } from "./delta/server.js";
import { Store as DeltaStore } from "./delta/store.js";
import { DB_PATH as DELTA_DB_PATH } from "./delta/config.js";

import { startCollector as startFundingCollector } from "./funding/collector.js";
import { startServer as startFundingServer } from "./funding/server.js";
import { Store as FundingStore } from "./funding/store.js";
import { FUNDING_DB_PATH } from "./funding/config.js";

console.log("Backdraft Seismographs — delta + funding\n");

const delta = new DeltaStore(DELTA_DB_PATH);
startDeltaCollector(delta);
startDeltaServer(delta);

const funding = new FundingStore(FUNDING_DB_PATH);
startFundingCollector(funding);
startFundingServer(funding);
