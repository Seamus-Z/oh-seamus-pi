import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";

/** List every project directory in the active OMP sessions root. */
export async function listSessionFolders(): Promise<string[]> {
	try {
		const entries = await fs.readdir(getSessionsDir(), { withFileTypes: true });
		return entries.filter(entry => entry.isDirectory()).map(entry => path.join(getSessionsDir(), entry.name));
	} catch {
		return [];
	}
}

/** List JSONL transcripts recursively within one project directory. */
export async function listSessionFiles(folderPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(folderPath, { recursive: true, withFileTypes: true });
		return entries
			.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(entry => path.join(entry.parentPath, entry.name));
	} catch {
		return [];
	}
}

/** List JSONL transcripts across all local OMP projects. */
export async function listAllSessionFiles(): Promise<string[]> {
	const folders = await listSessionFolders();
	const files = await Promise.all(folders.map(listSessionFiles));
	return files.flat();
}
