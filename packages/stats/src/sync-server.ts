import { Database } from "bun:sqlite";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	hashRecoveryToken,
	normalizeEmail,
	PASSWORD_RESET_TTL_MS,
	recoveryEmailConfigured,
	sendPasswordResetEmail,
} from "./password-recovery";

const MAX_BUNDLE_BYTES = 96 * 1024 * 1024;
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90;

interface SyncUserRow {
	id: number;
	username: string;
	password_hash: string;
	email: string | null;
	role: string;
}

interface SyncTokenRow {
	user_id: number;
	username: string;
	role: string;
	expires_at: number;
}

interface SyncSessionRow {
	id: string;
	source_session_id: string;
	title: string;
	cwd: string;
	device_name: string;
	created_at: number;
	updated_at: number;
	latest_version: number;
	size: number;
	content_hash: string;
}

interface SyncVersionRow {
	version: number;
	object_path: string;
	content_hash: string;
	size: number;
	created_at: number;
}

export interface SessionBundleFile {
	path: string;
	data: string;
}

export interface SessionBundle {
	sourceSessionId: string;
	title: string;
	cwd: string;
	deviceName: string;
	modifiedAt: string;
	transcriptFile: string;
	files: SessionBundleFile[];
}

export interface CloudSessionSummary {
	id: string;
	sourceSessionId: string;
	title: string;
	cwd: string;
	deviceName: string;
	createdAt: string;
	updatedAt: string;
	latestVersion: number;
	size: number;
	contentHash: string;
}

export interface SyncServerHandle {
	hostname: string;
	port: number;
	stop: () => void;
}

let syncDb: Database | undefined;

function syncRoot(): string {
	return process.env.OMP_SYNC_DIR || path.join(os.homedir(), ".omp", "sync");
}

function getSyncDb(): Database {
	if (syncDb) return syncDb;
	const root = syncRoot();
	fsSync.mkdirSync(root, { recursive: true });
	syncDb = new Database(path.join(root, "sync.db"), { create: true });
	syncDb.run("PRAGMA journal_mode = WAL");
	syncDb.run("PRAGMA foreign_keys = ON");
	syncDb.run(`
		CREATE TABLE IF NOT EXISTS sync_users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE COLLATE NOCASE,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'user',
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS sync_tokens (
			token_hash TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES sync_users(id) ON DELETE CASCADE,
			device_name TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS sync_sessions (
			id TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES sync_users(id) ON DELETE CASCADE,
			source_session_id TEXT NOT NULL,
			title TEXT NOT NULL,
			cwd TEXT NOT NULL,
			device_name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			latest_version INTEGER NOT NULL,
			UNIQUE(user_id, source_session_id)
		);
		CREATE TABLE IF NOT EXISTS sync_session_versions (
			session_id TEXT NOT NULL REFERENCES sync_sessions(id) ON DELETE CASCADE,
			version INTEGER NOT NULL,
			object_path TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			size INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY(session_id, version)
		);
		CREATE INDEX IF NOT EXISTS idx_sync_sessions_user_updated ON sync_sessions(user_id, updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_sync_tokens_expiry ON sync_tokens(expires_at);
		CREATE TABLE IF NOT EXISTS sync_password_resets (
			token_hash TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES sync_users(id) ON DELETE CASCADE,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_sync_password_resets_user_created
			ON sync_password_resets(user_id, created_at DESC);
	`);
	const columns = syncDb.prepare("PRAGMA table_info(sync_users)").all() as Array<{ name: string }>;
	if (!columns.some(column => column.name === "email")) syncDb.run("ALTER TABLE sync_users ADD COLUMN email TEXT");
	syncDb.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_users_email ON sync_users(email COLLATE NOCASE) WHERE email IS NOT NULL",
	);
	return syncDb;
}

function jsonError(error: string, status: number): Response {
	return Response.json({ error }, { status });
}

function normalizedUsername(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const username = value.trim();
	return /^[\p{L}\p{N}_.-]{3,32}$/u.test(username) ? username : undefined;
}

function normalizedPassword(value: unknown): string | undefined {
	return typeof value === "string" && value.length >= 10 && value.length <= 256 ? value : undefined;
}

async function requestBody(req: Request): Promise<Record<string, unknown> | undefined> {
	const contentLength = Number(req.headers.get("content-length") ?? 0);
	if (contentLength > MAX_BUNDLE_BYTES) return undefined;
	try {
		const value = (await req.json()) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Buffer.from(digest).toString("hex");
}

function setupRequired(): boolean {
	const row = getSyncDb().prepare("SELECT COUNT(*) AS count FROM sync_users").get() as { count: number };
	return row.count === 0;
}

async function issueToken(user: SyncUserRow, deviceName: string): Promise<Response> {
	const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	const now = Date.now();
	getSyncDb()
		.prepare(
			"INSERT INTO sync_tokens(token_hash, user_id, device_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(await sha256(token), user.id, deviceName, now + TOKEN_TTL_MS, now);
	return Response.json({
		token,
		expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
		user: { id: user.id, username: user.username, role: user.role },
	});
}

async function authenticate(req: Request): Promise<SyncUserRow | undefined> {
	const authorization = req.headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) return undefined;
	const token = authorization.slice(7).trim();
	if (!token) return undefined;
	const now = Date.now();
	const db = getSyncDb();
	db.prepare("DELETE FROM sync_tokens WHERE expires_at <= ?").run(now);
	const row = db
		.prepare(`
			SELECT t.user_id, u.username, u.role, u.password_hash, u.email, t.expires_at
			FROM sync_tokens t
			JOIN sync_users u ON u.id = t.user_id
			WHERE t.token_hash = ? AND t.expires_at > ?
		`)
		.get(await sha256(token), now) as (SyncTokenRow & { password_hash: string; email: string | null }) | undefined;
	return row
		? { id: row.user_id, username: row.username, role: row.role, password_hash: row.password_hash, email: row.email }
		: undefined;
}

async function setup(req: Request): Promise<Response> {
	if (!setupRequired()) return jsonError("Sync server already initialized", 409);
	const body = await requestBody(req);
	const username = normalizedUsername(body?.username);
	const password = normalizedPassword(body?.password);
	const email = normalizeEmail(body?.email);
	const deviceName = typeof body?.deviceName === "string" ? body.deviceName.trim().slice(0, 80) : "initial-device";
	if (!username) return jsonError("Username must be 3-32 letters, numbers, dots, dashes, or underscores", 400);
	if (!password) return jsonError("Password must be between 10 and 256 characters", 400);
	if (!email) return jsonError("A valid recovery email is required", 400);
	const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
	const result = getSyncDb()
		.prepare("INSERT INTO sync_users(username, password_hash, email, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
		.run(username, passwordHash, email, Date.now());
	return issueToken(
		{ id: Number(result.lastInsertRowid), username, password_hash: passwordHash, email, role: "admin" },
		deviceName,
	);
}

async function login(req: Request): Promise<Response> {
	const body = await requestBody(req);
	const username = normalizedUsername(body?.username);
	const password = normalizedPassword(body?.password);
	const deviceName = typeof body?.deviceName === "string" ? body.deviceName.trim().slice(0, 80) : "unknown-device";
	if (!username || !password) return jsonError("Invalid username or password", 401);
	const user = getSyncDb()
		.prepare("SELECT id, username, password_hash, email, role FROM sync_users WHERE username = ?")
		.get(username) as SyncUserRow | undefined;
	if (!user || !(await Bun.password.verify(password, user.password_hash))) {
		return jsonError("Invalid username or password", 401);
	}
	return issueToken(user, deviceName);
}

async function forgotSyncPassword(req: Request): Promise<Response> {
	if (!recoveryEmailConfigured()) return jsonError("Email recovery is not configured on this sync server", 503);
	const body = await requestBody(req);
	const username = normalizedUsername(body?.username);
	const email = normalizeEmail(body?.email);
	const generic = Response.json({ accepted: true }, { status: 202 });
	if (!username || !email) return generic;
	const db = getSyncDb();
	const user = db
		.prepare(
			"SELECT id, username, password_hash, email, role FROM sync_users WHERE username = ? AND email = ? COLLATE NOCASE",
		)
		.get(username, email) as SyncUserRow | undefined;
	if (!user) return generic;
	const now = Date.now();
	const recent = db
		.prepare("SELECT 1 FROM sync_password_resets WHERE user_id = ? AND created_at > ?")
		.get(user.id, now - 60_000);
	if (recent) return generic;
	const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	db.prepare("DELETE FROM sync_password_resets WHERE user_id = ? OR expires_at <= ?").run(user.id, now);
	db.prepare("INSERT INTO sync_password_resets(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
		await hashRecoveryToken(token),
		user.id,
		now + PASSWORD_RESET_TTL_MS,
		now,
	);
	const resetUrl = `${new URL(req.url).origin}/reset-password?token=${encodeURIComponent(token)}`;
	try {
		await sendPasswordResetEmail({ to: email, username: user.username, resetUrl, serviceName: "OMP Sync" });
	} catch (error) {
		db.prepare("DELETE FROM sync_password_resets WHERE user_id = ?").run(user.id);
		return jsonError(error instanceof Error ? error.message : "Unable to send reset email", 502);
	}
	return generic;
}

async function applySyncPasswordReset(token: string, password: string): Promise<Response> {
	const normalized = normalizedPassword(password);
	if (!token || !normalized) return jsonError("A valid reset token and 10+ character password are required", 400);
	const db = getSyncDb();
	const row = db
		.prepare("SELECT user_id FROM sync_password_resets WHERE token_hash = ? AND expires_at > ?")
		.get(await hashRecoveryToken(token), Date.now()) as { user_id: number } | undefined;
	if (!row) return jsonError("Reset link is invalid or expired", 400);
	const passwordHash = await Bun.password.hash(normalized, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
	const commit = db.transaction(() => {
		db.prepare("UPDATE sync_users SET password_hash = ? WHERE id = ?").run(passwordHash, row.user_id);
		db.prepare("DELETE FROM sync_password_resets WHERE user_id = ?").run(row.user_id);
		db.prepare("DELETE FROM sync_tokens WHERE user_id = ?").run(row.user_id);
	});
	commit();
	return Response.json({ reset: true });
}

async function resetSyncPassword(req: Request): Promise<Response> {
	const body = await requestBody(req);
	return applySyncPasswordReset(
		typeof body?.token === "string" ? body.token.trim() : "",
		typeof body?.password === "string" ? body.password : "",
	);
}

function resetPage(token: string, message = ""): Response {
	const safeToken = token
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	const safeMessage = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	return new Response(
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Reset OMP Sync password</title><style>body{color-scheme:dark;background:#111614;color:#eaf8f3;font:15px system-ui;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(88vw,420px);padding:32px;border:1px solid #2b443b;border-radius:22px;background:#18201d;box-shadow:12px 12px 30px #080b0a}h1{margin:0 0 8px}p{color:#9cafaa}label{display:grid;gap:7px;margin:22px 0 14px}input,button{padding:13px;border-radius:11px}input{border:1px solid #395249;background:#101513;color:#fff}button{border:0;background:#57dbb9;color:#07110e;font-weight:800}.message{color:#63e0bf}</style></head><body><main class="card"><h1>OMP Sync</h1><p>Choose a new password for your cloud sync account.</p>${safeMessage ? `<p class="message">${safeMessage}</p>` : `<form method="post" action="/reset-password/submit"><input type="hidden" name="token" value="${safeToken}"><label>New password<input type="password" name="password" minlength="10" required autocomplete="new-password"></label><button type="submit">Reset password</button></form>`}</main></body></html>`,
		{
			headers: {
				"content-type": "text/html; charset=utf-8",
				"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
			},
		},
	);
}

async function resetPageSubmit(req: Request): Promise<Response> {
	const form = await req.formData();
	const token = typeof form.get("token") === "string" ? String(form.get("token")) : "";
	const password = typeof form.get("password") === "string" ? String(form.get("password")) : "";
	const result = await applySyncPasswordReset(token, password);
	if (result.ok) return resetPage("", "Password updated. Return to OMP Manager and sign in again.");
	const body = (await result.json()) as { error: string };
	return resetPage(token, body.error);
}

async function updateSyncRecoveryEmail(user: SyncUserRow, req: Request): Promise<Response> {
	const body = await requestBody(req);
	const email = normalizeEmail(body?.email);
	const password = normalizedPassword(body?.password);
	if (!email || !password) return jsonError("A valid email and current password are required", 400);
	if (!(await Bun.password.verify(password, user.password_hash)))
		return jsonError("Current password is incorrect", 401);
	try {
		getSyncDb().prepare("UPDATE sync_users SET email = ? WHERE id = ?").run(email, user.id);
	} catch {
		return jsonError("That email is already bound to another account", 409);
	}
	return Response.json({ email, emailConfigured: recoveryEmailConfigured() });
}

function validBundle(value: unknown): value is SessionBundle {
	if (!value || typeof value !== "object") return false;
	const bundle = value as Record<string, unknown>;
	if (
		typeof bundle.sourceSessionId !== "string" ||
		!bundle.sourceSessionId ||
		typeof bundle.title !== "string" ||
		typeof bundle.cwd !== "string" ||
		typeof bundle.deviceName !== "string" ||
		typeof bundle.modifiedAt !== "string" ||
		typeof bundle.transcriptFile !== "string" ||
		!Array.isArray(bundle.files) ||
		bundle.files.length === 0
	) {
		return false;
	}
	let decodedBytes = 0;
	for (const file of bundle.files) {
		if (!file || typeof file !== "object") return false;
		const record = file as Record<string, unknown>;
		if (typeof record.path !== "string" || typeof record.data !== "string") return false;
		const normalized = record.path.replaceAll("\\", "/");
		if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
		decodedBytes += Math.floor((record.data.length * 3) / 4);
		if (decodedBytes > MAX_BUNDLE_BYTES) return false;
	}
	return bundle.files.some(file => file.path === bundle.transcriptFile && file.path.endsWith(".jsonl"));
}

function cloudSummary(row: SyncSessionRow): CloudSessionSummary {
	return {
		id: row.id,
		sourceSessionId: row.source_session_id,
		title: row.title,
		cwd: row.cwd,
		deviceName: row.device_name,
		createdAt: new Date(row.created_at).toISOString(),
		updatedAt: new Date(row.updated_at).toISOString(),
		latestVersion: row.latest_version,
		size: row.size,
		contentHash: row.content_hash,
	};
}

async function uploadBundle(user: SyncUserRow, req: Request): Promise<Response> {
	const body = await requestBody(req);
	if (!validBundle(body)) return jsonError("Invalid or oversized session bundle", 400);
	const serialized = JSON.stringify(body);
	const contentHash = await sha256(serialized);
	const db = getSyncDb();
	const existing = db
		.prepare("SELECT id, latest_version FROM sync_sessions WHERE user_id = ? AND source_session_id = ?")
		.get(user.id, body.sourceSessionId) as { id: string; latest_version: number } | undefined;
	if (existing) {
		const latest = db
			.prepare("SELECT content_hash FROM sync_session_versions WHERE session_id = ? AND version = ?")
			.get(existing.id, existing.latest_version) as { content_hash: string } | undefined;
		if (latest?.content_hash === contentHash) {
			return Response.json({ id: existing.id, version: existing.latest_version, unchanged: true });
		}
	}
	const sessionId = existing?.id ?? crypto.randomUUID();
	const version = (existing?.latest_version ?? 0) + 1;
	const relativeObjectPath = path.join(String(user.id), sessionId, `${version}.json.gz`);
	const absoluteObjectPath = path.join(syncRoot(), "objects", relativeObjectPath);
	await Bun.write(absoluteObjectPath, gzipSync(serialized));
	const now = Date.now();
	const size = Buffer.byteLength(serialized);
	const commit = db.transaction(() => {
		if (existing) {
			db.prepare(`
				UPDATE sync_sessions
				SET title = ?, cwd = ?, device_name = ?, updated_at = ?, latest_version = ?
				WHERE id = ? AND user_id = ?
			`).run(body.title, body.cwd, body.deviceName, now, version, sessionId, user.id);
		} else {
			db.prepare(`
				INSERT INTO sync_sessions(id, user_id, source_session_id, title, cwd, device_name, created_at, updated_at, latest_version)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(sessionId, user.id, body.sourceSessionId, body.title, body.cwd, body.deviceName, now, now, version);
		}
		db.prepare(`
			INSERT INTO sync_session_versions(session_id, version, object_path, content_hash, size, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(sessionId, version, relativeObjectPath, contentHash, size, now);
	});
	try {
		commit();
	} catch (error) {
		await fs.rm(absoluteObjectPath, { force: true });
		throw error;
	}
	return Response.json({ id: sessionId, version, unchanged: false, contentHash });
}

function listCloudSessions(user: SyncUserRow): Response {
	const rows = getSyncDb()
		.prepare(`
			SELECT s.*, v.size, v.content_hash
			FROM sync_sessions s
			JOIN sync_session_versions v ON v.session_id = s.id AND v.version = s.latest_version
			WHERE s.user_id = ?
			ORDER BY s.updated_at DESC
		`)
		.all(user.id) as SyncSessionRow[];
	return Response.json({ sessions: rows.map(cloudSummary) });
}

async function downloadBundle(user: SyncUserRow, sessionId: string, requestedVersion?: number): Promise<Response> {
	const session = getSyncDb()
		.prepare("SELECT latest_version FROM sync_sessions WHERE id = ? AND user_id = ?")
		.get(sessionId, user.id) as { latest_version: number } | undefined;
	if (!session) return jsonError("Cloud session not found", 404);
	const version = requestedVersion ?? session.latest_version;
	const row = getSyncDb()
		.prepare(
			"SELECT version, object_path, content_hash, size, created_at FROM sync_session_versions WHERE session_id = ? AND version = ?",
		)
		.get(sessionId, version) as SyncVersionRow | undefined;
	if (!row) return jsonError("Session version not found", 404);
	const compressed = await Bun.file(path.join(syncRoot(), "objects", row.object_path)).arrayBuffer();
	const bundle = JSON.parse(gunzipSync(compressed).toString("utf8")) as SessionBundle;
	return Response.json({
		sessionId,
		version,
		contentHash: row.content_hash,
		createdAt: new Date(row.created_at).toISOString(),
		bundle,
	});
}

export async function handleSyncApi(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const route = url.pathname;
	if (route === "/api/sync/status" && req.method === "GET") {
		return Response.json({
			setupRequired: setupRequired(),
			service: "omp-sync",
			version: 1,
			emailConfigured: recoveryEmailConfigured(),
		});
	}
	if (route === "/api/sync/setup" && req.method === "POST") return setup(req);
	if (route === "/api/sync/login" && req.method === "POST") return login(req);
	if (route === "/api/sync/password/forgot" && req.method === "POST") return forgotSyncPassword(req);
	if (route === "/api/sync/password/reset" && req.method === "POST") return resetSyncPassword(req);
	if (route === "/reset-password" && req.method === "GET") return resetPage(url.searchParams.get("token") ?? "");
	if (route === "/reset-password/submit" && req.method === "POST") return resetPageSubmit(req);
	const user = await authenticate(req);
	if (!user) return jsonError("Authentication required", 401);
	if (route === "/api/sync/recovery-email" && req.method === "PUT") return updateSyncRecoveryEmail(user, req);
	if (route === "/api/sync/sessions" && req.method === "GET") return listCloudSessions(user);
	if (route === "/api/sync/sessions" && req.method === "POST") return uploadBundle(user, req);
	const match = route.match(/^\/api\/sync\/sessions\/([0-9a-f-]{36})$/);
	if (match && req.method === "GET") {
		const rawVersion = url.searchParams.get("version");
		const version = rawVersion ? Number.parseInt(rawVersion, 10) : undefined;
		return downloadBundle(user, match[1]!, version);
	}
	return jsonError("Not found", 404);
}

export async function startSyncServer(port = 3850, hostname = "127.0.0.1"): Promise<SyncServerHandle> {
	const server = Bun.serve({
		port,
		hostname,
		maxRequestBodySize: MAX_BUNDLE_BYTES + 1024 * 1024,
		async fetch(req) {
			try {
				const response = await handleSyncApi(req);
				const headers = new Headers(response.headers);
				headers.set("x-omp-sync", "1");
				headers.set("x-content-type-options", "nosniff");
				return new Response(response.body, { status: response.status, headers });
			} catch (error) {
				return jsonError(error instanceof Error ? error.message : "Unknown error", 500);
			}
		},
	});
	return { hostname, port: server.port ?? port, stop: () => server.stop() };
}
