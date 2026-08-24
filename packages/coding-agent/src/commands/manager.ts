import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { managerHelp as commandHelp } from "../cli/command-help";
import type { ManagerCommandArgs } from "../cli/manager-cli";
import { runManagerCommand } from "../cli/manager-cli";
import * as theme from "../modes/theme/theme";

export default class Manager extends Command {
	static description = commandHelp.description;
	static flags = {
		port: Flags.integer({ char: "p", description: "Port for the manager server", default: 3848 }),
		host: Flags.string({ description: "Host to bind", default: "127.0.0.1" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Manager);
		const cmd: ManagerCommandArgs = {
			port: flags.port,
			host: flags.host ?? "127.0.0.1",
		};
		await theme.initTheme();
		await runManagerCommand(cmd);
	}
}
