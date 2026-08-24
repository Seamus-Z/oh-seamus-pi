import { formatManagerUrl, startManagerServer } from "@oh-my-pi/omp-stats/manager-server";
import chalk from "chalk";
import { openPath } from "../utils/open";

export interface ManagerCommandArgs {
	port: number;
	host: string;
}

export async function runManagerCommand(cmd: ManagerCommandArgs): Promise<void> {
	const { hostname, port, stop } = await startManagerServer(cmd.port, cmd.host);
	const url = `${formatManagerUrl(hostname, port)}/#/sessions`;
	console.log(chalk.green(`OMP Manager available at: ${url}`));
	openPath(url);
	console.log("Press Ctrl+C to stop\n");

	process.once("SIGINT", () => {
		stop();
		process.exit(0);
	});
	await Promise.withResolvers<void>().promise;
}
