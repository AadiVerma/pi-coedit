import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listWorkFiles, headCommit } from "./git.ts";
import type { FileStat, Snapshot, SnapshotDiff } from "./types.ts";
import { contentHash, isBinary, newId, toPosix } from "./util.ts";

export function readFileStat(worktree: string, file: string): { stat: FileStat; content: Buffer | null } | null {
	const abs = join(worktree, file);
	let st;
	try {
		st = statSync(abs);
	} catch {
		return null;
	}
	if (!st.isFile()) return null;
	let content: Buffer;
	try {
		content = readFileSync(abs);
	} catch {
		return null;
	}
	return {
		stat: { hash: contentHash(content), mtimeMs: st.mtimeMs, size: st.size, binary: isBinary(content) },
		content,
	};
}

export function readContent(worktree: string, file: string): string | null {
	try {
		return readFileSync(join(worktree, file), "utf8");
	} catch {
		return null;
	}
}

/**
 * Snapshot the tracked set: git-tracked plus untracked-not-ignored files.
 * With a previous snapshot, files whose mtime and size are unchanged reuse the
 * previous hash (the mtime pre-filter), so repeated snapshots only hash what moved.
 */
export async function takeSnapshot(worktree: string, prev?: Snapshot): Promise<Snapshot> {
	const files = new Map<string, FileStat>();
	const paths = await listWorkFiles(worktree);
	for (const file of paths) {
		const cached = prev?.files.get(file);
		let st: import("node:fs").Stats;
		try {
			st = statSync(join(worktree, file));
		} catch {
			continue;
		}
		if (!st.isFile()) continue;
		if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
			files.set(file, cached);
			continue;
		}
		const entry = readFileStat(worktree, file);
		if (entry) files.set(file, entry.stat);
	}
	const head = await headCommit(worktree);
	return { worktree, ts: new Date().toISOString(), head, files: files.size > 0 ? files : new Map() };
}

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];
	const renamed: Array<[string, string]> = [];

	for (const [file, stat] of after.files) {
		const old = before.files.get(file);
		if (!old) added.push(file);
		else if (old.hash !== stat.hash) changed.push(file);
	}
	for (const [file, stat] of before.files) {
		if (after.files.has(file)) continue;
		// Rename detection: same content hash appearing elsewhere in this transition.
		for (const [newFile, newStat] of after.files) {
			if (!before.files.has(newFile) && newStat.hash === stat.hash) {
				renamed.push([file, newFile]);
				break;
			}
		}
	}
	const renamedFrom = new Set(renamed.map(([f]) => f));
	const renamedTo = new Set(renamed.map(([, f]) => f));
	return {
		added: added.filter((f) => !renamedTo.has(f)),
		removed: removed.filter((f) => !renamedFrom.has(f)),
		changed,
		renamed,
	};
}

export function emptySnapshot(worktree: string): Snapshot {
	return { worktree, ts: new Date().toISOString(), head: null, files: new Map() };
}

export function snapshotId(): string {
	return newId();
}

export { toPosix };
