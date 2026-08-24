import * as path from "node:path";
import { parseCommandArgs } from "../../../src/utils/command-args";

const CONTEXT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_CONTEXT_BYTES = 25 * 1024 * 1024;

export interface HubMessage {
	role: "user" | "assistant";
	content: string;
}

export interface ContextBundleV1 {
	schemaVersion: 1;
	harness: {
		type: "omp";
		adapterVersion: "1";
	};
	contextId: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	originalCwd: string;
	messages: HubMessage[];
	attachments: [];
	documentRefs: [];
	resume: {
		format: "omp-jsonl";
		ompJsonl: string;
	};
}

export type HubCommand =
	| { kind: "help" }
	| { kind: "push"; sessionPath?: string }
	| { kind: "pull"; contextId: string; version?: number }
	| { kind: "files-put"; localPath: string; folder?: string }
	| { kind: "files-get"; documentId: string; outputPath?: string };

export function parseHubCommand(args: string): HubCommand {
	const tokens = parseCommandArgs(args);
	const [command, ...rest] = tokens;
	if (!command || command === "help" || command === "-h" || command === "--help") return { kind: "help" };
	if (command === "push") {
		if (rest.length > 1) throw new Error("Usage: /hub push [session-path]");
		return { kind: "push", sessionPath: rest[0] };
	}
	if (command === "pull") {
		const [contextId, rawVersion, ...extra] = rest;
		if (!contextId || extra.length > 0) throw new Error("Usage: /hub pull <context-id> [version]");
		if (rawVersion === undefined) return { kind: "pull", contextId };
		const version = Number(rawVersion);
		if (!Number.isInteger(version) || version < 1) throw new Error("Version must be a positive integer");
		return { kind: "pull", contextId, version };
	}
	if (command === "files" && rest[0] === "put") {
		const [, localPath, folder, ...extra] = rest;
		if (!localPath || extra.length > 0) throw new Error("Usage: /hub files put <local-path> [folder]");
		return { kind: "files-put", localPath, folder };
	}
	if (command === "files" && rest[0] === "get") {
		const [, documentId, outputPath, ...extra] = rest;
		if (!documentId || extra.length > 0) throw new Error("Usage: /hub files get <document-id> [output-path]");
		return { kind: "files-get", documentId, outputPath };
	}
	throw new Error(`Unknown Hub command: ${command}. Run /hub help.`);
}

export interface HubDocumentDownload {
	bytes: Uint8Array;
	filename?: string;
	mediaType?: string;
}

export interface HubDocumentTextRange {
	filename?: string;
	startLine: number;
	endLine: number;
	totalLines: number;
	truncated: boolean;
	lines: string[];
}

interface OmpSessionMetadata {
	id?: string;
	title?: string;
	timestamp?: string;
	cwd?: string;
}

interface HubErrorEnvelope {
	error?: {
		code?: string;
		message?: string;
	};
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const text: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") text.push(record.text);
	}
	return text.join("\n").trim();
}

function fallbackContextId(sessionPath: string): string {
	const stem = path.basename(sessionPath, path.extname(sessionPath));
	const normalized = stem.replace(/[^A-Za-z0-9._:-]/g, "-");
	return normalized || crypto.randomUUID();
}

export function parseOmpContextBundle(
	rawJsonl: string,
	sessionPath: string,
	modifiedAt = new Date().toISOString(),
): ContextBundleV1 {
	let session: OmpSessionMetadata = {};
	let title = "";
	const messages: HubMessage[] = [];

	for (const line of rawJsonl.split("\n")) {
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type === "session") session = entry as OmpSessionMetadata;
		if (entry.type === "title" && typeof entry.title === "string") title = entry.title;
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const content = textContent(message.content);
		if (content) messages.push({ role: message.role, content });
	}

	const contextId = session.id ?? fallbackContextId(sessionPath);
	if (!CONTEXT_ID_PATTERN.test(contextId))
		throw new Error(`OMP session id cannot be used as a Hub context id: ${contextId}`);
	const createdAt = session.timestamp ?? modifiedAt;
	return {
		schemaVersion: 1,
		harness: { type: "omp", adapterVersion: "1" },
		contextId,
		title: title || session.title || messages[0]?.content.split("\n")[0]?.slice(0, 120) || path.basename(sessionPath),
		createdAt,
		updatedAt: modifiedAt,
		originalCwd: session.cwd ?? "",
		messages,
		attachments: [],
		documentRefs: [],
		resume: { format: "omp-jsonl", ompJsonl: rawJsonl },
	};
}

export function extractOmpJsonl(payload: unknown): string {
	if (!payload || typeof payload !== "object") throw new Error("Hub returned an invalid context bundle");
	const response = payload as Record<string, unknown>;
	const candidate = response.bundle && typeof response.bundle === "object" ? response.bundle : response;
	const resume = (candidate as Record<string, unknown>).resume;
	if (!resume || typeof resume !== "object" || typeof (resume as Record<string, unknown>).ompJsonl !== "string") {
		throw new Error(
			"This Hub context has no lossless resume.ompJsonl payload; refusing to rebuild a lossy OMP session",
		);
	}
	const jsonl = (resume as Record<string, unknown>).ompJsonl as string;
	if (!jsonl.trim()) throw new Error("Hub returned an empty OMP session");
	return jsonl;
}

function apiBaseUrl(value: string): string {
	const base = value.trim().replace(/\/+$/, "");
	if (!base) throw new Error("HUB_BASE_URL is not configured");
	const url = new URL(base);
	return url.pathname.endsWith("/api/v1")
		? url.toString().replace(/\/$/, "")
		: `${url.toString().replace(/\/$/, "")}/api/v1`;
}

function contentDispositionFilename(value: string | null): string | undefined {
	if (!value) return undefined;
	const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
	if (encoded) {
		try {
			return path.basename(decodeURIComponent(encoded));
		} catch {}
	}
	const plain = value.match(/filename="?([^";]+)"?/i)?.[1];
	return plain ? path.basename(plain) : undefined;
}

export class HarnessCloudClient {
	readonly #baseUrl: string;
	readonly #token: string;

	constructor(baseUrl: string, token: string) {
		this.#baseUrl = apiBaseUrl(baseUrl);
		this.#token = token.trim();
		if (!this.#token) throw new Error("HUB_TOKEN is not configured");
	}

	async #request(endpoint: string, init?: RequestInit): Promise<unknown> {
		const response = await fetch(`${this.#baseUrl}${endpoint}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.#token}`,
				...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
				...init?.headers,
			},
		});
		const payload = (await response.json().catch(() => undefined)) as HubErrorEnvelope | undefined;
		if (!response.ok) {
			const detail = payload?.error?.message ?? `Hub request failed (${response.status})`;
			throw new Error(payload?.error?.code ? `${detail} [${payload.error.code}]` : detail);
		}
		return payload;
	}

	async push(bundle: ContextBundleV1): Promise<unknown> {
		const body = JSON.stringify(bundle);
		if (Buffer.byteLength(body) > MAX_CONTEXT_BYTES) {
			throw new Error("Context bundle exceeds the 25 MiB Hub limit; upload the JSONL as a document instead");
		}
		return this.#request("/contexts", { method: "POST", body });
	}

	async uploadDocument(filePath: string, folder?: string): Promise<unknown> {
		const file = Bun.file(filePath);
		const stat = await file.stat();
		if (stat.size > MAX_CONTEXT_BYTES) throw new Error("File exceeds the 25 MiB Hub upload limit");
		const form = new FormData();
		form.set("file", file, path.basename(filePath));
		if (folder) form.set("folder", folder);
		return this.#request("/documents", { method: "POST", body: form });
	}

	async downloadDocument(documentId: string, signal?: AbortSignal): Promise<HubDocumentDownload> {
		if (!CONTEXT_ID_PATTERN.test(documentId)) throw new Error("Invalid Hub document id");
		const response = await fetch(`${this.#baseUrl}/documents/${encodeURIComponent(documentId)}/content`, {
			headers: { authorization: `Bearer ${this.#token}` },
			signal,
		});
		if (!response.ok) {
			const payload = (await response.json().catch(() => undefined)) as HubErrorEnvelope | undefined;
			const detail = payload?.error?.message ?? `Hub request failed (${response.status})`;
			throw new Error(payload?.error?.code ? `${detail} [${payload.error.code}]` : detail);
		}
		return {
			bytes: new Uint8Array(await response.arrayBuffer()),
			filename: contentDispositionFilename(response.headers.get("content-disposition")),
			mediaType: response.headers.get("content-type") ?? undefined,
		};
	}

	async readTextDocument(
		documentId: string,
		startLine = 1,
		lineCount = 200,
		signal?: AbortSignal,
	): Promise<HubDocumentTextRange> {
		if (!Number.isInteger(startLine) || startLine < 1) throw new Error("startLine must be a positive integer");
		if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 500)
			throw new Error("lineCount must be an integer between 1 and 500");
		const download = await this.downloadDocument(documentId, signal);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(download.bytes);
		} catch {
			throw new Error("Hub document is not valid UTF-8 text; download it with /hub files get");
		}
		if (text.includes("\0")) throw new Error("Hub document appears to be binary; download it with /hub files get");
		const allLines = text.split(/\r?\n/);
		const startIndex = Math.min(startLine - 1, allLines.length);
		const lines = allLines.slice(startIndex, startIndex + lineCount);
		return {
			filename: download.filename,
			startLine,
			endLine: lines.length === 0 ? startLine - 1 : startLine + lines.length - 1,
			totalLines: allLines.length,
			truncated: startIndex + lines.length < allLines.length,
			lines,
		};
	}

	async pull(contextId: string, version?: number): Promise<string> {
		if (!CONTEXT_ID_PATTERN.test(contextId)) throw new Error("Invalid Hub context id");
		if (version !== undefined && (!Number.isInteger(version) || version < 1))
			throw new Error("Version must be a positive integer");
		const endpoint =
			version === undefined
				? `/contexts/${encodeURIComponent(contextId)}/current`
				: `/contexts/${encodeURIComponent(contextId)}/versions/${version}`;
		return extractOmpJsonl(await this.#request(endpoint));
	}
}
