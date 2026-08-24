import { ensureClientBuild, handleStatic } from "./client-assets";
import { handleManagerApi } from "./manager";

export interface ManagerSessionBridge {
	activateSession: (sessionPath: string) => Promise<void> | void;
}

export interface ManagerServer {
	hostname: string;
	port: number;
	stop: () => void;
}

export function formatManagerUrl(hostname: string, port: number): string {
	const urlHostname = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
	return `http://${urlHostname}:${port}`;
}

export async function startManagerServer(
	port = 3848,
	hostname = "127.0.0.1",
	bridge?: ManagerSessionBridge,
): Promise<ManagerServer> {
	if (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost") {
		throw new Error("OMP Manager currently supports loopback hosts only; remote access requires TLS.");
	}
	await ensureClientBuild();
	const server = Bun.serve({
		port,
		hostname,
		async fetch(req) {
			const url = new URL(req.url);
			try {
				const response = url.pathname.startsWith("/api/manager/")
					? await handleManagerApi(req, bridge)
					: url.pathname.startsWith("/api/")
						? Response.json({ error: "Manager API only" }, { status: 404 })
						: await handleStatic(url.pathname);
				const headers = new Headers(response.headers);
				headers.set("x-omp-manager", "1");
				headers.set("x-content-type-options", "nosniff");
				headers.set("referrer-policy", "no-referrer");
				headers.set(
					"content-security-policy",
					"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; script-src 'self'",
				);
				return new Response(response.body, { status: response.status, headers });
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
			}
		},
	});
	return { hostname, port: server.port ?? port, stop: () => server.stop() };
}
