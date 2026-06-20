// Funding — cross-venue perp funding-basis seismograph. Sibling to the delta
// module: its own process/container/DB so the funding dataset never gaps.
// Paper-first — this collects raw funding across venues and derives the
// dispersion board; the carry-aware paper ledger lands next.

import "dotenv/config";
import { startCollector } from "./collector.js";
import { FUNDING_DB_PATH } from "./config.js";
import { startServer } from "./server.js";
import { Store } from "./store.js";

console.log("Backdraft Funding — cross-venue perp funding seismograph");
console.log(`Database: ${FUNDING_DB_PATH}\n`);

const store = new Store(FUNDING_DB_PATH);
startCollector(store);
startServer(store);
