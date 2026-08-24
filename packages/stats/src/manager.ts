import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import type { ManagerSessionBridge } from "./manager-server";
import { handleManagerSyncApi } from "./manager-sync";
import {
	hashRecoveryToken,
	normalizeEmail,
	PASSWORD_RESET_TTL_MS,
	recoveryEmailConfigured,
	sendPasswordResetEmail,
} from "./password-recovery";
import { listAllSessionFiles } from "./session-files";

const COOKIE_NAME = "omp_manager_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_DETAIL_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 24_000;

interface UserRow {
	id: number;
	username: string;
	password_hash: string;
	email: string | null;
	role: string;
}

interface WebSessionRow {
	user_id: number;
	username: string;
	role: string;
	expires_at: number;
}

export interface ManagerUser {
	id: number;
	username: string;
	role: string;
}

export interface ManagerSessionSummary {
	id: string;
	title: string;
	cwd: string;
	createdAt: string;
	modifiedAt: string;
	size: number;
	messageCount: number;
	preview: string;
}

export interface ManagerTranscriptMessage {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	text: string;
	timestamp?: string;
	model?: string;
}

export interface ManagerSessionDetail extends ManagerSessionSummary {
	resumeCommand: string;
	messages: ManagerTranscriptMessage[];
	truncated: boolean;
}

let managerDb: Database | undefined;

function dbPath(): string {
	return path.join(getAgentDir(), "manager.db");
}

function getDb(): Database {
	if (managerDb) return managerDb;
	fs.mkdirSync(getAgentDir(), { recursive: true });
	managerDb = new Database(dbPath(), { create: true });
	fs.chmodSync(dbPath(), 0o600);
	managerDb.run("PRAGMA journal_mode = WAL");
	managerDb.run("PRAGMA foreign_keys = ON");
	managerDb.run(`
		CREATE TABLE IF NOT EXISTS manager_users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE COLLATE NOCASE,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'admin',
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS manager_web_sessions (
			token_hash TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES manager_users(id) ON DELETE CASCADE,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_manager_web_sessions_expiry
			ON manager_web_sessions(expires_at);
		CREATE TABLE IF NOT EXISTS manager_password_resets (
			token_hash TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES manager_users(id) ON DELETE CASCADE,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_manager_password_resets_user_created
			ON manager_password_resets(user_id, created_at DESC);
	`);
	const columns = managerDb.prepare("PRAGMA table_info(manager_users)").all() as Array<{ name: string }>;
	if (!columns.some(column => column.name === "email")) {
		managerDb.run("ALTER TABLE manager_users ADD COLUMN email TEXT");
	}
	managerDb.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_users_email ON manager_users(email COLLATE NOCASE) WHERE email IS NOT NULL",
	);
	return managerDb;
}

function normalizeUsername(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const username = value.trim();
	if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) return undefined;
	return username;
}

function normalizePassword(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length < 10 || value.length > 256) return undefined;
	return value;
}

async function tokenHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Buffer.from(digest).toString("hex");
}

function parseCookies(req: Request): Map<string, string> {
	const cookies = new Map<string, string>();
	for (const item of (req.headers.get("cookie") ?? "").split(";")) {
		const separator = item.indexOf("=");
		if (separator < 1) continue;
		cookies.set(item.slice(0, separator).trim(), decodeURIComponent(item.slice(separator + 1).trim()));
	}
	return cookies;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
	return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function jsonError(message: string, status: number): Response {
	return Response.json({ error: message }, { status });
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown> | undefined> {
	try {
		const body = (await req.json()) as unknown;
		return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function sameOrigin(req: Request): boolean {
	const origin = req.headers.get("origin");
	return origin === null || origin === new URL(req.url).origin;
}

async function currentUser(req: Request): Promise<ManagerUser | undefined> {
	const token = parseCookies(req).get(COOKIE_NAME);
	if (!token) return undefined;
	const hash = await tokenHash(token);
	const db = getDb();
	const now = Date.now();
	db.prepare("DELETE FROM manager_web_sessions WHERE expires_at <= ?").run(now);
	const row = db
		.prepare(`
			SELECT s.user_id, u.username, u.role, s.expires_at
			FROM manager_web_sessions s
			JOIN manager_users u ON u.id = s.user_id
			WHERE s.token_hash = ? AND s.expires_at > ?
		`)
		.get(hash, now) as WebSessionRow | undefined;
	if (!row) return undefined;
	return { id: row.user_id, username: row.username, role: row.role };
}

function hasUsers(): boolean {
	const row = getDb().prepare("SELECT COUNT(*) AS count FROM manager_users").get() as { count: number };
	return row.count > 0;
}

async function createLoginResponse(user: ManagerUser): Promise<Response> {
	const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	const hash = await tokenHash(token);
	const now = Date.now();
	getDb()
		.prepare("INSERT INTO manager_web_sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
		.run(hash, user.id, now + SESSION_TTL_MS, now);
	return Response.json(
		{ authenticated: true, user },
		{ headers: { "set-cookie": sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)) } },
	);
}

async function setup(req: Request): Promise<Response> {
	if (!sameOrigin(req)) return jsonError("Cross-origin request rejected", 403);
	if (hasUsers()) return jsonError("Manager account already exists", 409);
	const body = await parseJsonBody(req);
	const username = normalizeUsername(body?.username);
	const password = normalizePassword(body?.password);
	const email = normalizeEmail(body?.email);
	if (!username) return jsonError("Username must be 3-32 letters, numbers, dots, dashes, or underscores", 400);
	if (!password) return jsonError("Password must be between 10 and 256 characters", 400);
	if (!email) return jsonError("A valid recovery email is required", 400);
	const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
	const result = getDb()
		.prepare(
			"INSERT INTO manager_users(username, password_hash, email, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
		)
		.run(username, passwordHash, email, Date.now());
	return createLoginResponse({ id: Number(result.lastInsertRowid), username, role: "admin" });
}

async function forgotManagerPassword(req: Request): Promise<Response> {
	if (!sameOrigin(req)) return jsonError("Cross-origin request rejected", 403);
	if (!recoveryEmailConfigured()) return jsonError("Email recovery is not configured on this Manager", 503);
	const body = await parseJsonBody(req);
	const username = normalizeUsername(body?.username);
	const email = normalizeEmail(body?.email);
	const generic = Response.json({ accepted: true }, { status: 202 });
	if (!username || !email) return generic;
	const db = getDb();
	let user = db
		.prepare("SELECT id, username, password_hash, email, role FROM manager_users WHERE username = ?")
		.get(username) as UserRow | undefined;
	if (user?.email === null) {
		const count = db.prepare("SELECT COUNT(*) AS count FROM manager_users").get() as { count: number };
		if (count.count === 1) {
			try {
				db.prepare("UPDATE manager_users SET email = ? WHERE id = ? AND email IS NULL").run(email, user.id);
				user = { ...user, email };
			} catch {
				return generic;
			}
		}
	}
	if (!user?.email || user.email.toLowerCase() !== email) return generic;
	const now = Date.now();
	const recent = db
		.prepare("SELECT 1 FROM manager_password_resets WHERE user_id = ? AND created_at > ?")
		.get(user.id, now - 60_000);
	if (recent) return generic;
	const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
	db.prepare("DELETE FROM manager_password_resets WHERE user_id = ? OR expires_at <= ?").run(user.id, now);
	db.prepare(
		"INSERT INTO manager_password_resets(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
	).run(await hashRecoveryToken(token), user.id, now + PASSWORD_RESET_TTL_MS, now);
	const resetUrl = `${new URL(req.url).origin}/#/reset-password?token=${encodeURIComponent(token)}`;
	try {
		await sendPasswordResetEmail({ to: email, username: user.username, resetUrl, serviceName: "OMP Manager" });
	} catch (error) {
		db.prepare("DELETE FROM manager_password_resets WHERE user_id = ?").run(user.id);
		return jsonError(error instanceof Error ? error.message : "Unable to send reset email", 502);
	}
	return generic;
}

async function resetManagerPassword(req: Request): Promise<Response> {
	if (!sameOrigin(req)) return jsonError("Cross-origin request rejected", 403);
	const body = await parseJsonBody(req);
	const token = typeof body?.token === "string" ? body.token.trim() : "";
	const password = normalizePassword(body?.password);
	if (!token || !password) return jsonError("A valid reset token and 10+ character password are required", 400);
	const db = getDb();
	const now = Date.now();
	const row = db
		.prepare("SELECT user_id FROM manager_password_resets WHERE token_hash = ? AND expires_at > ?")
		.get(await hashRecoveryToken(token), now) as { user_id: number } | undefined;
	if (!row) return jsonError("Reset link is invalid or expired", 400);
	const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
	const commit = db.transaction(() => {
		db.prepare("UPDATE manager_users SET password_hash = ? WHERE id = ?").run(passwordHash, row.user_id);
		db.prepare("DELETE FROM manager_password_resets WHERE user_id = ?").run(row.user_id);
		db.prepare("DELETE FROM manager_web_sessions WHERE user_id = ?").run(row.user_id);
	});
	commit();
	return Response.json({ reset: true });
}

async function updateRecoveryEmail(req: Request, user: ManagerUser): Promise<Response> {
	if (!sameOrigin(req)) return jsonError("Cross-origin request rejected", 403);
	const body = await parseJsonBody(req);
	const email = normalizeEmail(body?.email);
	const password = normalizePassword(body?.password);
	if (!email || !password) return jsonError("A valid email and current password are required", 400);
	const row = getDb()
		.prepare("SELECT id, username, password_hash, email, role FROM manager_users WHERE id = ?")
		.get(user.id) as UserRow | undefined;
	if (!row || !(await Bun.password.verify(password, row.password_hash)))
		return jsonError("Current password is incorrect", 401);
	try {
		getDb().prepare("UPDATE manager_users SET email = ? WHERE id = ?").run(email, user.id);
	} catch {
		return jsonError("That email is already bound to another account", 409);
	}
	return Response.json({ email, emailConfigured: recoveryEmailConfigured() });
}

async function login(req: Request): Promise<Response> {
	if (!sameOrigin(req)) return jsonError("Cross-origin request rejected", 403);
	const body = await parseJsonBody(req);
	const username = normalizeUsername(body?.username);
	const password = normalizePassword(body?.password);
	if (!username || !password) return jsonError("Invalid username or password", 401);
	const row = getDb()
		.prepare("SELECT id, username, password_hash, email, role FROM manager_users WHERE username = ?")
		.get(username) as UserRow | undefined;
	if (!row || !(await Bun.password.verify(password, row.password_hash))) {
		return jsonError("Invalid username or password", 401);
	}
	return createLoginResponse({ id: row.id, username: row.username, role: row.role });
}

async function logout(req: Request): Promise<Response> {
	if (!sameOrigin(req)) return jsonError("Cross-origin request rejected", 403);
	const token = parseCookies(req).get(COOKIE_NAME);
	if (token)
		getDb()
			.prepare("DELETE FROM manager_web_sessions WHERE token_hash = ?")
			.run(await tokenHash(token));
	return Response.json({ authenticated: false }, { headers: { "set-cookie": sessionCookie("", 0) } });
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if ((record.type === "text" || record.type === "thinking") && typeof record.text === "string") {
			parts.push(record.text);
		} else if (record.type === "toolCall" && typeof record.name === "string") {
			parts.push(`[tool] ${record.name}`);
		}
	}
	return parts.join("\n");
}

function clipped(text: string, limit = MAX_MESSAGE_CHARS): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}\n…`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function sessionId(sessionPath: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionPath));
	return Buffer.from(digest).toString("hex").slice(0, 24);
}

function isMainSession(sessionPath: string): boolean {
	const relative = path.relative(getSessionsDir(), sessionPath);
	return relative.split(path.sep).length === 2;
}

async function inspectSession(sessionPath: string): Promise<ManagerSessionSummary | undefined> {
	try {
		const file = Bun.file(sessionPath);
		const [head, stat] = await Promise.all([file.slice(0, 32_768).text(), file.stat()]);
		let title = "";
		let cwd = "";
		let createdAt = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
		let preview = "";
		let messageCount = 0;
		for (const rawLine of head.split("\n")) {
			if (!rawLine) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(rawLine) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (entry.type === "title" && typeof entry.title === "string") title = entry.title.trim();
			if (entry.type === "session") {
				if (typeof entry.cwd === "string") cwd = entry.cwd;
				if (typeof entry.timestamp === "string") createdAt = entry.timestamp;
			}
			if (entry.type === "message") {
				messageCount++;
				const message = entry.message as Record<string, unknown> | undefined;
				if (!preview && message?.role === "user") preview = clipped(textFromContent(message.content).trim(), 220);
			}
		}
		return {
			id: await sessionId(sessionPath),
			title: title || preview.split("\n")[0]?.slice(0, 96) || "Untitled session",
			cwd,
			createdAt,
			modifiedAt: new Date(stat.mtimeMs).toISOString(),
			size: stat.size,
			messageCount,
			preview,
		};
	} catch {
		return undefined;
	}
}

async function allMainSessionPaths(): Promise<string[]> {
	return (await listAllSessionFiles()).filter(isMainSession);
}

export async function listManagerSessions(search: string): Promise<ManagerSessionSummary[]> {
	const summaries = await Promise.all((await allMainSessionPaths()).map(inspectSession));
	const needle = search.trim().toLocaleLowerCase();
	return summaries
		.filter((summary): summary is ManagerSessionSummary => summary !== undefined)
		.filter(summary => {
			if (!needle) return true;
			return `${summary.title}\n${summary.cwd}\n${summary.preview}`.toLocaleLowerCase().includes(needle);
		})
		.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function resolveSessionPath(id: string): Promise<string | undefined> {
	for (const sessionPath of await allMainSessionPaths()) {
		if ((await sessionId(sessionPath)) === id) return sessionPath;
	}
	return undefined;
}

export async function getManagerSession(id: string): Promise<ManagerSessionDetail | undefined> {
	const sessionPath = await resolveSessionPath(id);
	if (!sessionPath) return undefined;
	const summary = await inspectSession(sessionPath);
	if (!summary) return undefined;
	const messages: ManagerTranscriptMessage[] = [];
	let totalMessages = 0;
	const decoder = new TextDecoder();
	for await (const rawLine of readLines(Bun.file(sessionPath).stream())) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(decoder.decode(rawLine)) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		if (!message) continue;
		const rawRole = message.role;
		const role =
			rawRole === "user"
				? "user"
				: rawRole === "assistant"
					? "assistant"
					: rawRole === "toolResult"
						? "tool"
						: "system";
		const text = clipped(textFromContent(message.content).trim());
		if (!text) continue;
		totalMessages++;
		messages.push({
			id: typeof entry.id === "string" ? entry.id : `${totalMessages}`,
			role,
			text,
			timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
			model: typeof message.model === "string" ? message.model : undefined,
		});
		if (messages.length > MAX_DETAIL_MESSAGES) messages.shift();
	}
	const command = summary.cwd
		? `omp --cwd ${shellQuote(summary.cwd)} --resume ${shellQuote(sessionPath)}`
		: `omp --resume ${shellQuote(sessionPath)}`;
	return { ...summary, resumeCommand: command, messages, truncated: totalMessages > messages.length };
}

export async function handleManagerApi(req: Request, bridge?: ManagerSessionBridge): Promise<Response> {
	const url = new URL(req.url);
	const route = url.pathname;
	if (route === "/api/manager/status" && req.method === "GET") {
		const user = await currentUser(req);
		const account = user
			? (getDb().prepare("SELECT email FROM manager_users WHERE id = ?").get(user.id) as { email: string | null })
			: undefined;
		return Response.json({
			setupRequired: !hasUsers(),
			authenticated: user !== undefined,
			user,
			emailConfigured: recoveryEmailConfigured(),
			terminalConnected: bridge !== undefined,
			recoveryEmail: account?.email ?? undefined,
		});
	}
	if (route === "/api/manager/setup" && req.method === "POST") return setup(req);
	if (route === "/api/manager/login" && req.method === "POST") return login(req);
	if (route === "/api/manager/logout" && req.method === "POST") return logout(req);
	if (route === "/api/manager/password/forgot" && req.method === "POST") return forgotManagerPassword(req);
	if (route === "/api/manager/password/reset" && req.method === "POST") return resetManagerPassword(req);

	const user = await currentUser(req);
	if (!user) return jsonError("Authentication required", 401);
	if (route === "/api/manager/recovery-email" && req.method === "PUT") return updateRecoveryEmail(req, user);
	if (route.startsWith("/api/manager/sync/")) {
		return handleManagerSyncApi(req, user, resolveSessionPath, bridge);
	}
	if (route === "/api/manager/sessions" && req.method === "GET") {
		return Response.json({ sessions: await listManagerSessions(url.searchParams.get("search") ?? "") });
	}
	const match = route.match(/^\/api\/manager\/sessions\/([a-f0-9]{24})$/);
	if (match && req.method === "GET") {
		const session = await getManagerSession(match[1]!);
		return session ? Response.json(session) : jsonError("Session not found", 404);
	}
	return jsonError("Not found", 404);
}
