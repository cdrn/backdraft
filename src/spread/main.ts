// Spread — CEX↔DEX realizable-spread logger, standalone entry.
import "dotenv/config";
import { startCollector } from "./collector.js";
import { DB_PATH } from "./config.js";
import { startServer } from "./server.js";
import { Store } from "./store.js";

console.log("Backdraft Spread — CEX↔DEX realizable spread");
console.log(`Database: ${DB_PATH}\n`);

const store = new Store(DB_PATH);
const collector = startCollector(store);
startServer(store, collector);
