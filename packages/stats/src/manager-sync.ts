import { Database } from "bun:sqlite";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import type { ManagerUser } from "./manager";
import type { ManagerSessionBridge } from "./manager-server";
import type { SessionBundle, SessionBundleFile } from "./sync-server";

const MAX_BUNDLE_BYTES = 96 * 1024 * 1024;

interface SyncConnectionRow {
	base_url: string;
	username: string;
	token: string;
	expires_at: string;
}

interface SyncLoginResponse {
	token: string;
	expiresAt: string;
	user: { id: number; username: string; role: string };
}

interface DownloadResponse {
	sessionId: string;
	version: number;
	contentHash: string;
	createdAt: string;
	bundle: SessionBundle;
}

let connectionDb: Database | undefined;

function getConnectionDb(): Database {
	if (connectionDb) return connectionDb;
	const dbPath = path.join(getAgentDir(), "manager-sync.db");
	connectionDb = new Database(dbPath, { create: true });
	fsSync.chmodSync(dbPath, 0o600);
	connectionDb.run(`
		CREATE TABLE IF NOT EXISTS sync_connection (
			id INTEGER PRIMARY KEY CHECK(id = 1),
			base_url TEXT NOT NULL,
			username TEXT NOT NULL,
			token TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
	`);
	return connectionDb;
}

function jsonError(error: string, status: number): Response {
	return Response.json({ error }, { status });
}

async function jsonBody(req: Request): Promise<Record<string, unknown> | undefined> {
	try {
		const body = (await req.json()) as unknown;
		return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function normalizedBaseUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value.trim());
		const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
		if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

function connection(): SyncConnectionRow | undefined {
	return getConnectionDb()
		.prepare("SELECT base_url, username, token, expires_at FROM sync_connection WHERE id = 1")
		.get() as SyncConnectionRow | undefined;
}

async function syncFetch(endpoint: string, options?: RequestInit): Promise<Response> {
	const current = connection();
	if (!current) throw new Error("No sync server connected");
	const response = await fetch(`${current.base_url}${endpoint}`, {
		...options,
		headers: { authorization: `Bearer ${current.token}`, ...options?.headers },
	});
	if (response.status === 401) getConnectionDb().prepare("DELETE FROM sync_connection WHERE id = 1").run();
	return response;
}

async function connect(req: Request, bridge?: ManagerSessionBridge): Promise<Response> {
	const body = await jsonBody(req);
	const baseUrl = normalizedBaseUrl(body?.baseUrl);
	const username = typeof body?.username === "string" ? body.username.trim() : "";
	const password = typeof body?.password === "string" ? body.password : "";
	const email = typeof body?.email === "string" ? body.email.trim() : undefined;
	if (!baseUrl) return jsonError("Use an HTTPS URL, or loopback HTTP for local development", 400);
	if (!username || !password) return jsonError("Username and password are required", 400);
	let status: { setupRequired?: boolean };
	try {
		const statusResponse = await fetch(`${baseUrl}/api/sync/status`);
		if (!statusResponse.ok) return jsonError(`Sync server status failed (${statusResponse.status})`, 502);
		status = (await statusResponse.json()) as { setupRequired?: boolean };
	} catch (error) {
		return jsonError(error instanceof Error ? error.message : "Sync server unavailable", 502);
	}
	const endpoint = status.setupRequired ? "/api/sync/setup" : "/api/sync/login";
	const loginResponse = await fetch(`${baseUrl}${endpoint}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password, email, deviceName: os.hostname() }),
	});
	const result = (await loginResponse.json().catch(() => undefined)) as
		| (SyncLoginResponse & { error?: string })
		| undefined;
	if (!loginResponse.ok || !result?.token) {
		return jsonError(result?.error ?? `Sync login failed (${loginResponse.status})`, loginResponse.status);
	}
	getConnectionDb()
		.prepare(`
			INSERT INTO sync_connection(id, base_url, username, token, expires_at, updated_at)
			VALUES (1, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				base_url = excluded.base_url,
				username = excluded.username,
				token = excluded.token,
				expires_at = excluded.expires_at,
				updated_at = excluded.updated_at
		`)
		.run(baseUrl, result.user.username, result.token, result.expiresAt, Date.now());
	return Response.json({
		connected: true,
		baseUrl,
		username: result.user.username,
		expiresAt: result.expiresAt,
		terminalConnected: bridge !== undefined,
	});
}

async function forgotCloudPassword(req: Request): Promise<Response> {
	const body = await jsonBody(req);
	const baseUrl = normalizedBaseUrl(body?.baseUrl);
	const username = typeof body?.username === "string" ? body.username.trim() : "";
	const email = typeof body?.email === "string" ? body.email.trim() : "";
	if (!baseUrl || !username || !email) return jsonError("Server URL, username, and recovery email are required", 400);
	try {
		const response = await fetch(`${baseUrl}/api/sync/password/forgot`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username, email }),
		});
		return Response.json(await response.json(), { status: response.status });
	} catch (error) {
		return jsonError(error instanceof Error ? error.message : "Sync server unavailable", 502);
	}
}

async function updateCloudRecoveryEmail(req: Request): Promise<Response> {
	const body = await jsonBody(req);
	const response = await syncFetch("/api/sync/recovery-email", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: body?.email, password: body?.password }),
	});
	return Response.json(await response.json(), { status: response.status });
}

function safeRelativePath(value: string): string | undefined {
	const normalized = value.replaceAll("\\", "/");
	if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return undefined;
	return normalized;
}

async function collectDirectory(root: string, prefix: string): Promise<SessionBundleFile[]> {
	let entries: fsSync.Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: SessionBundleFile[] = [];
	for (const entry of entries) {
		const absolute = path.join(root, entry.name);
		const relative = path.posix.join(prefix, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectDirectory(absolute, relative)));
		} else if (entry.isFile()) {
			files.push({ path: relative, data: Buffer.from(await Bun.file(absolute).arrayBuffer()).toString("base64") });
		}
	}
	return files;
}

async function sessionHeader(
	sessionPath: string,
): Promise<{ id: string; title: string; cwd: string; modifiedAt: string }> {
	const file = Bun.file(sessionPath);
	const [head, stat] = await Promise.all([file.slice(0, 32_768).text(), file.stat()]);
	let id = path.basename(sessionPath, ".jsonl");
	let title = "";
	let cwd = "";
	for (const line of head.split("\n")) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type === "title" && typeof entry.title === "string") title = entry.title.trim();
			if (entry.type === "session") {
				if (typeof entry.id === "string") id = entry.id;
				if (typeof entry.cwd === "string") cwd = entry.cwd;
			}
		} catch {}
	}
	return { id, title: title || "Untitled session", cwd, modifiedAt: new Date(stat.mtimeMs).toISOString() };
}

export async function createSessionBundle(sessionPath: string): Promise<SessionBundle> {
	const header = await sessionHeader(sessionPath);
	const transcriptFile = path.basename(sessionPath);
	const transcript = Buffer.from(await Bun.file(sessionPath).arrayBuffer());
	const artifactsName = path.basename(sessionPath, ".jsonl");
	const artifacts = await collectDirectory(path.join(path.dirname(sessionPath), artifactsName), artifactsName);
	const files: SessionBundleFile[] = [{ path: transcriptFile, data: transcript.toString("base64") }, ...artifacts];
	const encodedBytes = files.reduce((total, file) => total + Math.floor((file.data.length * 3) / 4), 0);
	if (encodedBytes > MAX_BUNDLE_BYTES) throw new Error("Session bundle exceeds the 96 MiB upload limit");
	return {
		sourceSessionId: header.id,
		title: header.title,
		cwd: header.cwd,
		deviceName: os.hostname(),
		modifiedAt: header.modifiedAt,
		transcriptFile,
		files,
	};
}

async function upload(sessionPath: string): Promise<Response> {
	const bundle = await createSessionBundle(sessionPath);
	const response = await syncFetch("/api/sync/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(bundle),
	});
	const result = await response.json();
	return Response.json(result, { status: response.status });
}

async function listCloud(): Promise<Response> {
	const response = await syncFetch("/api/sync/sessions");
	const result = await response.json();
	return Response.json(result, { status: response.status });
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function pull(sessionId: string, req: Request, bridge?: ManagerSessionBridge): Promise<Response> {
	const body = req.headers.get("content-length") === "0" ? undefined : await jsonBody(req);
	const rawVersion = typeof body?.version === "number" ? body.version : undefined;
	const response = await syncFetch(
		`/api/sync/sessions/${encodeURIComponent(sessionId)}${rawVersion ? `?version=${rawVersion}` : ""}`,
	);
	if (!response.ok) return Response.json(await response.json(), { status: response.status });
	const download = (await response.json()) as DownloadResponse;
	const destinationDir = path.join(getSessionsDir(), `cloud-${sessionId}-v${download.version}`);
	await fs.mkdir(destinationDir, { recursive: true });
	let transcriptPath = "";
	for (const file of download.bundle.files) {
		const relative = safeRelativePath(file.path);
		if (!relative) return jsonError("Cloud bundle contains an unsafe path", 400);
		const destination = path.join(destinationDir, relative);
		if (!path.resolve(destination).startsWith(path.resolve(destinationDir) + path.sep)) {
			return jsonError("Cloud bundle path escaped the destination", 400);
		}
		await Bun.write(destination, Buffer.from(file.data, "base64"));
		if (relative === download.bundle.transcriptFile) transcriptPath = destination;
	}
	if (!transcriptPath) return jsonError("Cloud bundle transcript is missing", 400);
	const cwd = typeof body?.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : download.bundle.cwd;
	let command = `omp --resume ${shellQuote(transcriptPath)}`;
	try {
		if (cwd && (await fs.stat(cwd)).isDirectory())
			command = `omp --cwd ${shellQuote(cwd)} --resume ${shellQuote(transcriptPath)}`;
	} catch {}
	const activate = bridge !== undefined && body?.activate !== false;
	if (activate) {
		setTimeout(() => {
			void Promise.resolve(bridge.activateSession(transcriptPath)).catch(error =>
				console.error("Failed to activate downloaded OMP session", error),
			);
		}, 100);
	}
	return Response.json({
		imported: true,
		localPath: transcriptPath,
		resumeCommand: command,
		version: download.version,
		activationRequested: activate,
	});
}

export async function handleManagerSyncApi(
	req: Request,
	_user: ManagerUser,
	resolveLocalSession: (id: string) => Promise<string | undefined>,
	bridge?: ManagerSessionBridge,
): Promise<Response> {
	const url = new URL(req.url);
	const route = url.pathname;
	if (route === "/api/manager/sync/connection" && req.method === "GET") {
		const current = connection();
		return Response.json({
			connected: current !== undefined,
			baseUrl: current?.base_url,
			username: current?.username,
			expiresAt: current?.expires_at,
			terminalConnected: bridge !== undefined,
		});
	}
	if (route === "/api/manager/sync/connect" && req.method === "POST") return connect(req, bridge);
	if (route === "/api/manager/sync/password/forgot" && req.method === "POST") return forgotCloudPassword(req);
	if (route === "/api/manager/sync/recovery-email" && req.method === "PUT") {
		try {
			return await updateCloudRecoveryEmail(req);
		} catch (error) {
			return jsonError(error instanceof Error ? error.message : "Sync server unavailable", 502);
		}
	}
	if (route === "/api/manager/sync/connection" && req.method === "DELETE") {
		getConnectionDb().prepare("DELETE FROM sync_connection WHERE id = 1").run();
		return Response.json({ connected: false });
	}
	if (route === "/api/manager/sync/cloud-sessions" && req.method === "GET") {
		try {
			return await listCloud();
		} catch (error) {
			return jsonError(error instanceof Error ? error.message : "Sync server unavailable", 502);
		}
	}
	const uploadMatch = route.match(/^\/api\/manager\/sync\/sessions\/([a-f0-9]{24})\/upload$/);
	if (uploadMatch && req.method === "POST") {
		const sessionPath = await resolveLocalSession(uploadMatch[1]!);
		if (!sessionPath) return jsonError("Local session not found", 404);
		try {
			return await upload(sessionPath);
		} catch (error) {
			return jsonError(error instanceof Error ? error.message : "Upload failed", 502);
		}
	}
	const pullMatch = route.match(/^\/api\/manager\/sync\/cloud-sessions\/([0-9a-f-]{36})\/pull$/);
	if (pullMatch && req.method === "POST") {
		try {
			return await pull(pullMatch[1]!, req, bridge);
		} catch (error) {
			return jsonError(error instanceof Error ? error.message : "Download failed", 502);
		}
	}
	return jsonError("Not found", 404);
}
