import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface SentEmail {
	subject: string;
	text: string;
	to: string[];
}

const emails: SentEmail[] = [];
let mailServer: ReturnType<typeof Bun.serve>;
let manager: Bun.Subprocess<"ignore", "pipe", "pipe">;
let sync: Bun.Subprocess<"ignore", "pipe", "pipe">;
let managerOrigin = "";
let syncOrigin = "";
let root = "";

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
	throw new Error(`Recovery test server did not start: ${output}`);
}

function tokenFromLatestEmail(service: string): string {
	const email = emails.findLast(message => message.subject.includes(service));
	expect(email).toBeDefined();
	const link = email!.text.match(/https?:\/\/\S+/)?.[0];
	expect(link).toBeDefined();
	const url = new URL(link!);
	return url.searchParams.get("token") ?? new URLSearchParams(url.hash.split("?", 2)[1] ?? "").get("token")!;
}

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-password-recovery-"));
	mailServer = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			emails.push((await req.json()) as SentEmail);
			return Response.json({ id: crypto.randomUUID() });
		},
	});
	await fs.mkdir(path.join(root, "agent"), { recursive: true });
	const common = {
		RESEND_API_KEY: "test-api-key",
		OMP_MAIL_FROM: "OMP Test <noreply@example.com>",
		RESEND_API_URL: `http://127.0.0.1:${mailServer.port}/emails`,
	};
	const managerStarted = await startChild(
		"import { startManagerServer } from './src/manager-server.ts'; const server = await startManagerServer(0); console.log(server.port); await Promise.withResolvers().promise;",
		{ ...common, PI_CODING_AGENT_DIR: path.join(root, "agent") },
	);
	manager = managerStarted.child;
	managerOrigin = managerStarted.origin;
	const syncStarted = await startChild(
		"import { startSyncServer } from './src/sync-server.ts'; const server = await startSyncServer(0); console.log(server.port); await Promise.withResolvers().promise;",
		{ ...common, OMP_SYNC_DIR: path.join(root, "sync") },
	);
	sync = syncStarted.child;
	syncOrigin = syncStarted.origin;
});

afterAll(async () => {
	manager?.kill();
	sync?.kill();
	mailServer?.stop();
	await Promise.all([manager?.exited, sync?.exited]);
	if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("email password recovery", () => {
	test("resets a local Manager password and revokes the old login", async () => {
		const setup = await fetch(`${managerOrigin}/api/manager/setup`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: managerOrigin },
			body: JSON.stringify({
				username: "manager-user",
				email: "manager@example.com",
				password: "manager-old-password",
			}),
		});
		expect(setup.status).toBe(200);
		const forgot = await fetch(`${managerOrigin}/api/manager/password/forgot`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: managerOrigin },
			body: JSON.stringify({ username: "manager-user", email: "manager@example.com" }),
		});
		expect(forgot.status).toBe(202);
		const token = tokenFromLatestEmail("OMP Manager");
		const reset = await fetch(`${managerOrigin}/api/manager/password/reset`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: managerOrigin },
			body: JSON.stringify({ token, password: "manager-new-password" }),
		});
		expect(reset.status).toBe(200);
		const oldLogin = await fetch(`${managerOrigin}/api/manager/login`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: managerOrigin },
			body: JSON.stringify({ username: "manager-user", password: "manager-old-password" }),
		});
		expect(oldLogin.status).toBe(401);
		const newLogin = await fetch(`${managerOrigin}/api/manager/login`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: managerOrigin },
			body: JSON.stringify({ username: "manager-user", password: "manager-new-password" }),
		});
		expect(newLogin.status).toBe(200);
	});

	test("resets a cloud Sync password and revokes existing device tokens", async () => {
		const setup = await fetch(`${syncOrigin}/api/sync/setup`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				username: "cloud-user",
				email: "cloud@example.com",
				password: "cloud-old-password",
				deviceName: "test",
			}),
		});
		expect(setup.status).toBe(200);
		const setupResult = (await setup.json()) as { token: string };
		const forgot = await fetch(`${syncOrigin}/api/sync/password/forgot`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "cloud-user", email: "cloud@example.com" }),
		});
		expect(forgot.status).toBe(202);
		const token = tokenFromLatestEmail("OMP Sync");
		const reset = await fetch(`${syncOrigin}/api/sync/password/reset`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, password: "cloud-new-password" }),
		});
		expect(reset.status).toBe(200);
		const revoked = await fetch(`${syncOrigin}/api/sync/sessions`, {
			headers: { authorization: `Bearer ${setupResult.token}` },
		});
		expect(revoked.status).toBe(401);
		const oldLogin = await fetch(`${syncOrigin}/api/sync/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "cloud-user", password: "cloud-old-password", deviceName: "test" }),
		});
		expect(oldLogin.status).toBe(401);
		const newLogin = await fetch(`${syncOrigin}/api/sync/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "cloud-user", password: "cloud-new-password", deviceName: "test" }),
		});
		expect(newLogin.status).toBe(200);
	});
});
