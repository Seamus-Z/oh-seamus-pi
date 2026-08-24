import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let manager: Bun.Subprocess<"ignore", "pipe", "pipe">;
let sync: Bun.Subprocess<"ignore", "pipe", "pipe">;
let managerOrigin = "";
let syncOrigin = "";
let root = "";
let handoffPath = "";

async function startChild(
	code: string,
	env: Record<string, string>,
): Promise<{ child: Bun.Subprocess<"ignore", "pipe", "pipe">; origin: string }> {
	const child = Bun.spawn([process.execPath, "-e", code], {
		cwd: path.join(import.meta.dir, ".."),
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let output = "";
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		output += decoder.decode(value, { stream: true });
		const port = output
			.split("\n")
			.map(line => Number.parseInt(line.trim(), 10))
			.find(value => Number.isInteger(value) && value > 0);
		if (port) {
			reader.releaseLock();
			return { child, origin: `http://127.0.0.1:${port}` };
		}
	}
	throw new Error(`Test server did not start: ${output}`);
}

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sync-roundtrip-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(agentDir, "sessions", "test-project");
	await fs.mkdir(projectDir, { recursive: true });
	await Bun.write(
		path.join(projectDir, "sample.jsonl"),
		`${[
			JSON.stringify({ type: "title", v: 1, title: "Roundtrip context", updatedAt: "2026-08-24T00:00:00.000Z" }),
			JSON.stringify({
				type: "session",
				version: 3,
				id: "11111111-2222-4333-8444-555555555555",
				timestamp: "2026-08-24T00:00:00.000Z",
				cwd: root,
			}),
			JSON.stringify({
				type: "message",
				id: "message-one",
				parentId: null,
				timestamp: "2026-08-24T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "preserve this context" }] },
			}),
		].join("\n")}\n`,
	);
	const syncStarted = await startChild(
		"import { startSyncServer } from './src/sync-server.ts'; const server = await startSyncServer(0); console.log(server.port); await Promise.withResolvers().promise;",
		{ OMP_SYNC_DIR: path.join(root, "sync") },
	);
	sync = syncStarted.child;
	syncOrigin = syncStarted.origin;
	handoffPath = path.join(root, "activated-session.txt");
	const managerStarted = await startChild(
		"import { startManagerServer } from './src/manager-server.ts'; const server = await startManagerServer(0, '127.0.0.1', { activateSession: sessionPath => Bun.write(process.env.HANDOFF_PATH!, sessionPath) }); console.log(server.port); await Promise.withResolvers().promise;",
		{ PI_CODING_AGENT_DIR: agentDir, HANDOFF_PATH: handoffPath },
	);
	manager = managerStarted.child;
	managerOrigin = managerStarted.origin;
});

afterAll(async () => {
	manager?.kill();
	sync?.kill();
	await Promise.all([manager?.exited, sync?.exited]);
	if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("manager session sync", () => {
	test("uploads a local session and downloads an importable cloud copy", async () => {
		const setup = await fetch(`${managerOrigin}/api/manager/setup`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: managerOrigin },
			body: JSON.stringify({
				username: "local-admin",
				email: "local@example.com",
				password: "local-manager-password",
			}),
		});
		expect(setup.status).toBe(200);
		const cookie = setup.headers.get("set-cookie")!;

		const connected = await fetch(`${managerOrigin}/api/manager/sync/connect`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie, origin: managerOrigin },
			body: JSON.stringify({
				baseUrl: syncOrigin,
				username: "cloud-admin",
				email: "cloud@example.com",
				password: "cloud-sync-password",
			}),
		});
		expect(connected.status).toBe(200);
		expect(await connected.json()).toMatchObject({
			connected: true,
			baseUrl: syncOrigin,
			username: "cloud-admin",
			terminalConnected: true,
		});

		const localResponse = await fetch(`${managerOrigin}/api/manager/sessions`, { headers: { cookie } });
		const local = (await localResponse.json()) as { sessions: Array<{ id: string; title: string }> };
		expect(local.sessions).toHaveLength(1);
		expect(local.sessions[0]?.title).toBe("Roundtrip context");

		const uploaded = await fetch(`${managerOrigin}/api/manager/sync/sessions/${local.sessions[0]!.id}/upload`, {
			method: "POST",
			headers: { cookie, origin: managerOrigin },
		});
		expect(uploaded.status).toBe(200);
		expect(await uploaded.json()).toMatchObject({ version: 1, unchanged: false });

		const cloudResponse = await fetch(`${managerOrigin}/api/manager/sync/cloud-sessions`, { headers: { cookie } });
		const cloud = (await cloudResponse.json()) as {
			sessions: Array<{ id: string; title: string; latestVersion: number }>;
		};
		expect(cloud.sessions).toHaveLength(1);
		expect(cloud.sessions[0]).toMatchObject({ title: "Roundtrip context", latestVersion: 1 });

		const unauthorizedPull = await fetch(
			`${managerOrigin}/api/manager/sync/cloud-sessions/${cloud.sessions[0]!.id}/pull`,
			{ method: "POST", headers: { "content-type": "application/json", origin: managerOrigin }, body: "{}" },
		);
		expect(unauthorizedPull.status).toBe(401);

		const pulled = await fetch(`${managerOrigin}/api/manager/sync/cloud-sessions/${cloud.sessions[0]!.id}/pull`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie, origin: managerOrigin },
			body: JSON.stringify({ version: 1 }),
		});
		expect(pulled.status).toBe(200);
		const result = (await pulled.json()) as { imported: boolean; localPath: string; resumeCommand: string };
		expect(result.imported).toBe(true);
		expect(result.resumeCommand).toContain("omp --cwd");
		expect(await Bun.file(result.localPath).text()).toContain("preserve this context");
		await Bun.sleep(150);
		expect(await Bun.file(handoffPath).text()).toBe(result.localPath);
	});
});
