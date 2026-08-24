#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { formatManagerUrl, startManagerServer } from "./manager-server";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		port: { type: "string", short: "p", default: "3848" },
		host: { type: "string", default: "127.0.0.1" },
	},
});
const port = Number.parseInt(values.port ?? "3848", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	throw new Error("--port must be an integer between 0 and 65535");
}
const server = await startManagerServer(port, values.host ?? "127.0.0.1");
const url = `${formatManagerUrl(server.hostname, server.port)}/#/sessions`;
console.log(`OMP Manager available at: ${url}`);
console.log("Press Ctrl+C to stop");
process.once("SIGINT", () => {
	server.stop();
	process.exit(0);
});
await Promise.withResolvers<void>().promise;
