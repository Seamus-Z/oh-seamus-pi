import { describe, expect, test } from "bun:test";
import { extractOmpJsonl, HarnessCloudClient, parseHubCommand, parseOmpContextBundle } from "./adapter";

const SESSION_JSONL = [
	JSON.stringify({ type: "title", v: 1, title: "Hub adapter test" }),
	JSON.stringify({
		type: "session",
		version: 3,
		id: "11111111-2222-4333-8444-555555555555",
		timestamp: "2026-08-24T00:00:00.000Z",
		cwd: "/work/project",
	}),
	JSON.stringify({
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "preserve this context" }] },
	}),
	JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", text: "private reasoning" },
				{ type: "text", text: "visible answer" },
				{ type: "toolCall", name: "read", arguments: {} },
			],
		},
	}),
].join("\n");

describe("OMP Harness Cloud adapter", () => {
	test("maps preview fields while preserving the exact OMP JSONL for lossless resume", () => {
		const bundle = parseOmpContextBundle(SESSION_JSONL, "/sessions/source.jsonl", "2026-08-24T01:00:00.000Z");

		expect(bundle).toMatchObject({
			schemaVersion: 1,
			harness: { type: "omp", adapterVersion: "1" },
			contextId: "11111111-2222-4333-8444-555555555555",
			title: "Hub adapter test",
			createdAt: "2026-08-24T00:00:00.000Z",
			updatedAt: "2026-08-24T01:00:00.000Z",
			originalCwd: "/work/project",
			messages: [
				{ role: "user", content: "preserve this context" },
				{ role: "assistant", content: "visible answer" },
			],
		});
		expect(bundle.resume.ompJsonl).toBe(SESSION_JSONL);
		expect(extractOmpJsonl({ bundle })).toBe(SESSION_JSONL);
	});

	test("uses bearer-scoped context endpoints for push and versioned pull", async () => {
		const requests: Array<{ path: string; authorization: string | null; body?: unknown }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				requests.push({
					path: url.pathname,
					authorization: req.headers.get("authorization"),
					body: req.method === "POST" ? await req.json() : undefined,
				});
				if (req.method === "POST") return Response.json({ version: 2 });
				return Response.json({ resume: { ompJsonl: SESSION_JSONL } });
			},
		});
		try {
			const client = new HarnessCloudClient(`http://127.0.0.1:${server.port}`, "hcdt_secret");
			const bundle = parseOmpContextBundle(SESSION_JSONL, "/sessions/source.jsonl");
			expect(await client.push(bundle)).toEqual({ version: 2 });
			expect(await client.pull(bundle.contextId, 3)).toBe(SESSION_JSONL);
			expect(requests).toEqual([
				{
					path: "/api/v1/contexts",
					authorization: "Bearer hcdt_secret",
					body: bundle,
				},
				{
					path: `/api/v1/contexts/${bundle.contextId}/versions/3`,
					authorization: "Bearer hcdt_secret",
					body: undefined,
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	test("routes the parent command and preserves quoted file arguments", () => {
		expect(parseHubCommand("")).toEqual({ kind: "help" });
		expect(parseHubCommand("push")).toEqual({ kind: "push", sessionPath: undefined });
		expect(parseHubCommand("pull thread-1 3")).toEqual({ kind: "pull", contextId: "thread-1", version: 3 });
		expect(parseHubCommand('files put "notes and plans.md" "run books"')).toEqual({
			kind: "files-put",
			localPath: "notes and plans.md",
			folder: "run books",
		});
		expect(parseHubCommand('files get document-1 "downloads/my notes.md"')).toEqual({
			kind: "files-get",
			documentId: "document-1",
			outputPath: "downloads/my notes.md",
		});
		expect(() => parseHubCommand("files delete document-1")).toThrow("Run /hub help");
	});

	test("uploads a file as bearer-authenticated multipart data", async () => {
		let uploaded:
			| { authorization: string | null; name: string; folder: string; content: string; contentType: string | null }
			| undefined;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const form = await req.formData();
				const file = form.get("file");
				if (!(file instanceof File)) return Response.json({ error: { message: "Missing file" } }, { status: 400 });
				uploaded = {
					authorization: req.headers.get("authorization"),
					name: file.name,
					folder: String(form.get("folder") ?? ""),
					content: await file.text(),
					contentType: req.headers.get("content-type"),
				};
				return Response.json({ id: "document-1", name: file.name });
			},
		});
		try {
			const client = new HarnessCloudClient(`http://127.0.0.1:${server.port}`, "hcdt_files");
			const fixturePath = `${import.meta.dir}/fixtures/smoke-session.jsonl`;
			expect(await client.uploadDocument(fixturePath, "runbooks")).toEqual({
				id: "document-1",
				name: "smoke-session.jsonl",
			});
			expect(uploaded).toEqual({
				authorization: "Bearer hcdt_files",
				name: "smoke-session.jsonl",
				folder: "runbooks",
				content: await Bun.file(fixturePath).text(),
				contentType: expect.stringContaining("multipart/form-data; boundary="),
			});
		} finally {
			server.stop(true);
		}
	});

	test("downloads binary document content with bearer authentication and its server filename", async () => {
		const bytes = new Uint8Array([0, 1, 2, 255]);
		let authorization: string | null = null;
		let requestPath = "";
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				authorization = req.headers.get("authorization");
				requestPath = new URL(req.url).pathname;
				return new Response(bytes, {
					headers: {
						"content-disposition": "attachment; filename*=UTF-8''notes%20and%20plans.bin",
						"content-type": "application/octet-stream",
					},
				});
			},
		});
		try {
			const client = new HarnessCloudClient(`http://127.0.0.1:${server.port}`, "hcdt_files");
			const download = await client.downloadDocument("document-1");
			expect(download).toEqual({
				bytes,
				filename: "notes and plans.bin",
				mediaType: "application/octet-stream",
			});
			await expect(client.readTextDocument("document-1")).rejects.toThrow("not valid UTF-8 text");
			expect(requestPath).toBe("/api/v1/documents/document-1/content");
			expect(authorization).toBe("Bearer hcdt_files");
		} finally {
			server.stop(true);
		}
	});

	test("returns only the requested text lines for AI context", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("alpha\nbeta\ngamma\ndelta", {
					headers: {
						"content-disposition": 'attachment; filename="notes.txt"',
						"content-type": "text/plain",
					},
				});
			},
		});
		try {
			const client = new HarnessCloudClient(`http://127.0.0.1:${server.port}`, "hcdt_read");
			expect(await client.readTextDocument("document-2", 2, 2)).toEqual({
				filename: "notes.txt",
				startLine: 2,
				endLine: 3,
				totalLines: 4,
				truncated: true,
				lines: ["beta", "gamma"],
			});
		} finally {
			server.stop(true);
		}
	});

	test("refuses a lossy pull when the Hub bundle lacks the original OMP JSONL", () => {
		expect(() => extractOmpJsonl({ messages: [{ role: "user", content: "preview only" }] })).toThrow(
			"refusing to rebuild a lossy OMP session",
		);
	});
});
