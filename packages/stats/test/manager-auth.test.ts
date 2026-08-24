import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
let origin = "";
let agentDir = "";

beforeAll(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-manager-test-"));
	child = Bun.spawn(
		[
			process.execPath,
			"-e",
			"import { startManagerServer } from './src/manager-server.ts'; const server = await startManagerServer(0); console.log(server.port); await Promise.withResolvers().promise;",
		],
		{
			cwd: path.join(import.meta.dir, ".."),
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
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
			origin = `http://127.0.0.1:${port}`;
			reader.releaseLock();
			return;
		}
	}
	throw new Error(`Manager test server did not start: ${output}`);
});

afterAll(async () => {
	child?.kill();
	await child?.exited;
	if (agentDir) await fs.rm(agentDir, { recursive: true, force: true });
});

describe("manager authentication", () => {
	test("requires setup, creates an admin session, and invalidates it on logout", async () => {
		const initial = await fetch(`${origin}/api/manager/status`);
		expect(initial.status).toBe(200);
		expect(await initial.json()).toMatchObject({ setupRequired: true, authenticated: false });

		const unauthorized = await fetch(`${origin}/api/manager/sessions`);
		expect(unauthorized.status).toBe(401);

		const setup = await fetch(`${origin}/api/manager/setup`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({
				username: "local-admin",
				email: "local@example.com",
				password: "correct-horse-battery",
			}),
		});
		expect(setup.status).toBe(200);
		const cookie = setup.headers.get("set-cookie");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");

		const sessions = await fetch(`${origin}/api/manager/sessions`, { headers: { cookie: cookie! } });
		expect(sessions.status).toBe(200);
		expect(await sessions.json()).toEqual({ sessions: [] });

		const logout = await fetch(`${origin}/api/manager/logout`, {
			method: "POST",
			headers: { cookie: cookie!, origin },
		});
		expect(logout.status).toBe(200);
		const invalidated = await fetch(`${origin}/api/manager/sessions`, { headers: { cookie: cookie! } });
		expect(invalidated.status).toBe(401);
	});
});
