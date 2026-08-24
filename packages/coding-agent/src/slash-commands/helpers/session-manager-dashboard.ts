import * as stats from "@oh-my-pi/omp-stats";
import * as openUtils from "../../utils/open";

interface ManagerDashboardServer {
	hostname: string;
	port: number;
	stop: () => void;
}

type SessionActivator = (sessionPath: string) => Promise<void>;

let activeManagerServer: ManagerDashboardServer | undefined;
let activateCurrentSession: SessionActivator | undefined;

export interface ManagerDashboardLaunchResult {
	url: string;
	message: string;
}

export async function launchSessionManagerDashboard(
	activateSession: SessionActivator,
): Promise<ManagerDashboardLaunchResult> {
	activateCurrentSession = activateSession;
	if (!activeManagerServer) {
		activeManagerServer = await stats.startManagerServer(0, "127.0.0.1", {
			async activateSession(sessionPath) {
				const activate = activateCurrentSession;
				if (!activate) throw new Error("The originating OMP terminal is no longer connected");
				await activate(sessionPath);
			},
		});
	}
	const url = `${stats.formatManagerUrl(activeManagerServer.hostname, activeManagerServer.port)}/#/cloud`;
	openUtils.openPath(url);
	return {
		url,
		message: `OMP Manager connected to this terminal\n${url}\nCloud downloads will open in the active OMP session.`,
	};
}

export function stopSessionManagerDashboard(): void {
	activateCurrentSession = undefined;
	activeManagerServer?.stop();
	activeManagerServer = undefined;
}
