#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { startSyncServer } from "./sync-server";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		port: { type: "string", short: "p", default: "3850" },
		host: { type: "string", default: "127.0.0.1" },
	},
});
const port = Number.parseInt(values.port ?? "3850", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	throw new Error("--port must be an integer between 0 and 65535");
}
const server = await startSyncServer(port, values.host ?? "127.0.0.1");
console.log(`OMP Sync Server available at: http://${server.hostname}:${server.port}`);
console.log(`Storage: ${process.env.OMP_SYNC_DIR || "~/.omp/sync"}`);
console.log("Press Ctrl+C to stop");
process.once("SIGINT", () => {
	server.stop();
	process.exit(0);
});
await Promise.withResolvers<void>().promise;
