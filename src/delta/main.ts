// Delta — stablecoin venue-basis seismograph. Runs as its own process
// (separate container in production) so the dataset never gaps while the
// main backdraft scanner/executor iterates.

import "dotenv/config";
import { DB_PATH } from "./config.js";
import { startCollector } from "./collector.js";
import { startServer } from "./server.js";
import { Store } from "./store.js";

console.log("Backdraft Delta — venue-basis seismograph");
console.log(`Database: ${DB_PATH}\n`);

const store = new Store(DB_PATH);
startCollector(store);
startServer(store);
