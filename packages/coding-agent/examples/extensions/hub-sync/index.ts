import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils";
import { HarnessCloudClient, type HubCommand, parseHubCommand, parseOmpContextBundle } from "./adapter";

const HUB_HELP = `Harness Cloud

/hub help
  Show this help.

/hub push [session-path]
  Upload the current OMP session, or a specified JSONL session.

/hub pull <context-id> [version]
  Download a lossless OMP context and open it in this terminal.

/hub files put <local-path> [folder]
  Upload a local file to the Hub file space. Quote paths containing spaces.

/hub files get <document-id> [output-path]
  Download a Hub file without overwriting an existing local file.`;

function hubClient(): HarnessCloudClient {
	return new HarnessCloudClient(process.env.HUB_BASE_URL ?? "", process.env.HUB_TOKEN ?? "");
}

async function push(command: Extract<HubCommand, { kind: "push" }>, ctx: ExtensionCommandContext): Promise<void> {
	const sessionPath = command.sessionPath ? path.resolve(command.sessionPath) : ctx.sessionManager.getSessionFile();
	if (!sessionPath) throw new Error("The current OMP session has not been persisted yet");
	const file = Bun.file(sessionPath);
	let rawJsonl: string;
	try {
		rawJsonl = await file.text();
	} catch (error) {
		if (isEnoent(error)) throw new Error("The current OMP session has not been persisted yet");
		throw error;
	}
	const modifiedAt = file.lastModified > 0 ? new Date(file.lastModified).toISOString() : new Date().toISOString();
	const bundle = parseOmpContextBundle(rawJsonl, sessionPath, modifiedAt);
	const response = (await hubClient().push(bundle)) as Record<string, unknown> | undefined;
	const version = typeof response?.version === "number" ? ` version ${response.version}` : "";
	ctx.ui.notify(`Uploaded ${bundle.contextId}${version} to Harness Cloud`, "info");
}

async function pull(command: Extract<HubCommand, { kind: "pull" }>, ctx: ExtensionCommandContext): Promise<void> {
	const jsonl = await hubClient().pull(command.contextId, command.version);
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	const outputPath = path.join(
		ctx.sessionManager.getSessionDir(),
		"hub-pull",
		`${timestamp}_${command.contextId}.jsonl`,
	);
	await Bun.write(outputPath, jsonl);
	const result = await ctx.switchSession(outputPath);
	if (result.cancelled) throw new Error(`Session downloaded to ${outputPath}, but switching was cancelled`);
	ctx.ui.notify(
		`Downloaded and opened ${command.contextId}${command.version === undefined ? "" : ` version ${command.version}`}`,
		"info",
	);
}

async function putFile(
	command: Extract<HubCommand, { kind: "files-put" }>,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const localPath = path.resolve(command.localPath);
	let response: Record<string, unknown> | undefined;
	try {
		response = (await hubClient().uploadDocument(localPath, command.folder)) as Record<string, unknown> | undefined;
	} catch (error) {
		if (isEnoent(error)) throw new Error(`File not found: ${localPath}`);
		throw error;
	}
	const documentId = typeof response?.id === "string" ? ` (${response.id})` : "";
	ctx.ui.notify(`Uploaded ${path.basename(localPath)} to Hub file space${documentId}`, "info");
}

async function getFile(
	command: Extract<HubCommand, { kind: "files-get" }>,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const download = await hubClient().downloadDocument(command.documentId);
	const fallbackName = download.filename ?? command.documentId;
	const outputPath = command.outputPath
		? path.resolve(command.outputPath)
		: path.join(ctx.sessionManager.getCwd(), path.basename(fallbackName));
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(outputPath, "wx");
	} catch (error) {
		if (isEexist(error)) throw new Error(`Refusing to overwrite existing file: ${outputPath}`);
		throw error;
	}
	try {
		await handle.writeFile(download.bytes);
	} finally {
		await handle.close();
	}
	ctx.ui.notify(`Downloaded ${command.documentId} to ${outputPath}`, "info");
}

export default function hubSyncExtension(api: ExtensionAPI): void {
	const z = api.zod;
	api.registerTool({
		name: "hub_file_read",
		label: "Hub File Read",
		description:
			"Read a bounded UTF-8 line range from a Harness Cloud document into model context without saving a local file. Use this when the user provides a Hub document ID; request only the lines needed.",
		parameters: z.object({
			documentId: z.string().describe("Harness Cloud document ID"),
			startLine: z.number().int().min(1).default(1).describe("First line to return, starting at 1"),
			lineCount: z.number().int().min(1).max(500).default(200).describe("Maximum number of lines to return"),
		}),
		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			const range = await hubClient().readTextDocument(
				params.documentId,
				params.startLine,
				params.lineCount,
				signal,
			);
			const name = range.filename ? ` (${range.filename})` : "";
			const body = range.lines.map((line, index) => `${range.startLine + index}:${line}`).join("\n");
			return {
				content: [
					{
						type: "text",
						text: [
							`[Hub document ${params.documentId}${name}] lines ${range.startLine}-${range.endLine} of ${range.totalLines}`,
							body,
							range.truncated ? `[More lines available. Continue at startLine ${range.endLine + 1}.]` : "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: range,
			};
		},
	});

	api.registerCommand("hub", {
		description: "Push, pull, and manage Harness Cloud files",
		async handler(args, ctx) {
			try {
				const command = parseHubCommand(args);
				switch (command.kind) {
					case "help":
						ctx.ui.notify(HUB_HELP, "info");
						break;
					case "push":
						await push(command, ctx);
						break;
					case "pull":
						await pull(command, ctx);
						break;
					case "files-put":
						await putFile(command, ctx);
						break;
					case "files-get":
						await getFile(command, ctx);
						break;
				}
			} catch (error) {
				ctx.ui.notify(`Hub command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
