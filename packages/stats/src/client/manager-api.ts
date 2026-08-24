export interface ManagerUser {
	id: number;
	username: string;
	role: string;
}

export interface ManagerStatus {
	setupRequired: boolean;
	authenticated: boolean;
	user?: ManagerUser;
	emailConfigured: boolean;
	recoveryEmail?: string;
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

async function managerRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
	const response = await fetch(endpoint, {
		credentials: "same-origin",
		...options,
		headers: options?.body ? { "content-type": "application/json", ...options.headers } : options?.headers,
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
		throw new Error(body?.error ?? `Request failed (${response.status})`);
	}
	return response.json() as Promise<T>;
}

export async function getManagerStatus(): Promise<ManagerStatus | undefined> {
	const response = await fetch("/api/manager/status", { credentials: "same-origin" });
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`Manager status failed (${response.status})`);
	return response.json() as Promise<ManagerStatus>;
}

export function setupManager(username: string, email: string, password: string): Promise<ManagerStatus> {
	return managerRequest("/api/manager/setup", { method: "POST", body: JSON.stringify({ username, email, password }) });
}

export function loginManager(username: string, password: string): Promise<ManagerStatus> {
	return managerRequest("/api/manager/login", { method: "POST", body: JSON.stringify({ username, password }) });
}

export function forgotManagerPassword(username: string, email: string): Promise<{ accepted: true }> {
	return managerRequest("/api/manager/password/forgot", { method: "POST", body: JSON.stringify({ username, email }) });
}

export function resetManagerPassword(token: string, password: string): Promise<{ reset: true }> {
	return managerRequest("/api/manager/password/reset", { method: "POST", body: JSON.stringify({ token, password }) });
}

export function updateManagerRecoveryEmail(
	email: string,
	password: string,
): Promise<{ email: string; emailConfigured: boolean }> {
	return managerRequest("/api/manager/recovery-email", { method: "PUT", body: JSON.stringify({ email, password }) });
}

export function logoutManager(): Promise<{ authenticated: false }> {
	return managerRequest("/api/manager/logout", { method: "POST" });
}

export async function listManagerSessions(search: string): Promise<ManagerSessionSummary[]> {
	const result = await managerRequest<{ sessions: ManagerSessionSummary[] }>(
		`/api/manager/sessions?search=${encodeURIComponent(search)}`,
	);
	return result.sessions;
}

export function getManagerSession(id: string): Promise<ManagerSessionDetail> {
	return managerRequest(`/api/manager/sessions/${encodeURIComponent(id)}`);
}

export interface SyncConnection {
	connected: boolean;
	baseUrl?: string;
	username?: string;
	expiresAt?: string;
	terminalConnected?: boolean;
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

export interface PullResult {
	imported: boolean;
	localPath: string;
	resumeCommand: string;
	version: number;
	activationRequested: boolean;
}

export function getSyncConnection(): Promise<SyncConnection> {
	return managerRequest("/api/manager/sync/connection");
}

export function connectSyncServer(
	baseUrl: string,
	username: string,
	password: string,
	email?: string,
): Promise<SyncConnection> {
	return managerRequest("/api/manager/sync/connect", {
		method: "POST",
		body: JSON.stringify({ baseUrl, username, password, email }),
	});
}

export function forgotSyncPassword(baseUrl: string, username: string, email: string): Promise<{ accepted: true }> {
	return managerRequest("/api/manager/sync/password/forgot", {
		method: "POST",
		body: JSON.stringify({ baseUrl, username, email }),
	});
}

export function updateSyncRecoveryEmail(
	email: string,
	password: string,
): Promise<{ email: string; emailConfigured: boolean }> {
	return managerRequest("/api/manager/sync/recovery-email", {
		method: "PUT",
		body: JSON.stringify({ email, password }),
	});
}

export function disconnectSyncServer(): Promise<SyncConnection> {
	return managerRequest("/api/manager/sync/connection", { method: "DELETE" });
}

export async function listCloudSessions(): Promise<CloudSessionSummary[]> {
	const result = await managerRequest<{ sessions: CloudSessionSummary[] }>("/api/manager/sync/cloud-sessions");
	return result.sessions;
}

export function uploadManagerSession(id: string): Promise<{ id: string; version: number; unchanged: boolean }> {
	return managerRequest(`/api/manager/sync/sessions/${encodeURIComponent(id)}/upload`, { method: "POST" });
}

export function pullCloudSession(id: string, version?: number, activate = true): Promise<PullResult> {
	return managerRequest(`/api/manager/sync/cloud-sessions/${encodeURIComponent(id)}/pull`, {
		method: "POST",
		body: JSON.stringify({ version, activate }),
	});
}
