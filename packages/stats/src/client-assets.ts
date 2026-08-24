import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { $ } from "bun";
import { decodeEmbeddedClientArchive } from "./embedded-client";
import embeddedClientArchiveTxt from "./embedded-client.generated.txt";

const EMBEDDED_CLIENT_ARCHIVE = decodeEmbeddedClientArchive(embeddedClientArchiveTxt);
const CLIENT_DIR = path.join(import.meta.dir, "client");
const STATIC_DIR = path.join(import.meta.dir, "..", "dist", "client");
const IS_BUN_COMPILED =
	Boolean(process.env.PI_COMPILED || Bun.env.PI_COMPILED) ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");
const IS_PREBUILT = IS_BUN_COMPILED || Boolean(process.env.PI_BUNDLED || Bun.env.PI_BUNDLED);
const USE_EMBEDDED_CLIENT = EMBEDDED_CLIENT_ARCHIVE !== null || IS_PREBUILT;
const EMBEDDED_CLIENT_DIR_ROOT = path.join(os.tmpdir(), "omp-stats-client");
let embeddedClientDirPromise: Promise<string> | null = null;

function sanitizeArchivePath(archivePath: string): string | null {
	const normalized = archivePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized === ".") return null;
	if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
	return normalized;
}

async function extractEmbeddedClientArchive(archiveBytes: Buffer, outputDir: string): Promise<void> {
	const archive = new Bun.Archive(archiveBytes);
	const files = await archive.files();
	const extractRoot = path.resolve(outputDir);
	for (const [archivePath, file] of files) {
		const sanitizedPath = sanitizeArchivePath(archivePath);
		if (!sanitizedPath) continue;
		const destinationPath = path.resolve(extractRoot, sanitizedPath);
		if (!destinationPath.startsWith(extractRoot + path.sep)) {
			throw new Error(`Archive entry escapes extraction directory: ${archivePath}`);
		}
		await Bun.write(destinationPath, file);
	}
}

async function getEmbeddedClientDir(): Promise<string> {
	if (!USE_EMBEDDED_CLIENT) return STATIC_DIR;
	if (embeddedClientDirPromise) return embeddedClientDirPromise;
	if (!EMBEDDED_CLIENT_ARCHIVE) {
		throw new Error("Embedded dashboard client missing. Rebuild the omp binary or npm bundle with embedded assets.");
	}
	embeddedClientDirPromise = (async () => {
		const bundleHash = Bun.hash(EMBEDDED_CLIENT_ARCHIVE).toString(16);
		const outputDir = path.join(EMBEDDED_CLIENT_DIR_ROOT, bundleHash);
		const markerPath = path.join(outputDir, "index.html");
		try {
			const marker = await fs.stat(markerPath);
			if (marker.isFile()) return outputDir;
		} catch {}
		await fs.rm(outputDir, { recursive: true, force: true });
		await fs.mkdir(outputDir, { recursive: true });
		await extractEmbeddedClientArchive(EMBEDDED_CLIENT_ARCHIVE, outputDir);
		return outputDir;
	})();
	return embeddedClientDirPromise;
}

async function getLatestMtime(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return 0;
		throw err;
	}
	const results = await Promise.allSettled(
		entries.map(entry => {
			const fullPath = path.join(dir, entry.name);
			return entry.isDirectory() ? getLatestMtime(fullPath) : fs.stat(fullPath).then(stats => stats.mtimeMs);
		}),
	);
	let latest = 0;
	for (const result of results) {
		if (result.status === "fulfilled") latest = Math.max(latest, result.value);
	}
	return latest;
}

export async function ensureClientBuild(): Promise<void> {
	if (USE_EMBEDDED_CLIENT) return;
	const indexPath = path.join(STATIC_DIR, "index.html");
	const cssPath = path.join(STATIC_DIR, "styles.css");
	const clientSourceMtime = await getLatestMtime(CLIENT_DIR);
	const tailwindConfigPath = path.join(import.meta.dir, "..", "tailwind.config.js");
	let tailwindConfigMtime = 0;
	try {
		tailwindConfigMtime = (await fs.stat(tailwindConfigPath)).mtimeMs;
	} catch {}
	const sourceMtime = Math.max(clientSourceMtime, tailwindConfigMtime);
	try {
		const [indexStats, cssStats] = await Promise.all([fs.stat(indexPath), fs.stat(cssPath)]);
		if (
			indexStats.isFile() &&
			cssStats.isFile() &&
			indexStats.mtimeMs >= sourceMtime &&
			cssStats.mtimeMs >= sourceMtime
		) {
			return;
		}
	} catch {}

	await fs.rm(STATIC_DIR, { recursive: true, force: true });
	console.log("Building dashboard client...");
	const buildResult = await $`bun run build.ts`
		.cwd(path.join(import.meta.dir, ".."))
		.quiet()
		.nothrow();
	if (buildResult.exitCode !== 0) {
		const output = buildResult.text().trim();
		throw new Error(`Failed to build dashboard client (exit ${buildResult.exitCode})${output ? `\n${output}` : ""}`);
	}
	await Bun.write(
		path.join(STATIC_DIR, "index.html"),
		`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>OMP Control Center</title><link rel="stylesheet" href="styles.css"></head><body><div id="root"></div><script src="index.js" type="module"></script></body></html>`,
	);
}

export async function handleStatic(requestPath: string): Promise<Response> {
	const staticDir = await getEmbeddedClientDir();
	const filePath = requestPath === "/" ? "/index.html" : requestPath;
	const file = Bun.file(path.join(staticDir, filePath));
	if (await file.exists()) return new Response(file);
	const index = Bun.file(path.join(staticDir, "index.html"));
	return (await index.exists()) ? new Response(index) : new Response("Not Found", { status: 404 });
}
