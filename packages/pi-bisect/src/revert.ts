/**
 * Revert exactly one agent edit: for each file the culprit touched, locate the
 * culprit's inserted lines in the CURRENT working file (by content, allowing
 * drift) and restore the lines the culprit replaced. Falls back to this after
 * `git apply` fails, because later edits often change the hunk's context lines.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { computeHunks } from "@coedit/core";
import type { ShadowMeta } from "./shadow.ts";

const exec = promisify(execFile);

export interface RevertResult {
	ok: boolean;
	filesChanged: string[];
	conflicts: string[];
}

export async function revertEdit(repo: string, culprit: ShadowMeta, parent: ShadowMeta | null): Promise<RevertResult> {
	const result: RevertResult = { ok: true, filesChanged: [], conflicts: [] };
	let files = culprit.files.filter(Boolean);
	if (files.length === 0 && parent) {
		try {
			const { stdout } = await exec("git", ["diff", "--name-only", parent.sha, culprit.sha], { cwd: repo, maxBuffer: 1024 * 1024 });
			files = stdout.trim().split("\n").filter(Boolean);
		} catch {
			/* keep as-is */
		}
	}
	for (const file of files) {
		const after = await showOrNull(repo, culprit.sha, file);
		const before = parent ? await showOrNull(repo, parent.sha, file) : "";
		if (after === null) {
			// file was deleted by the culprit: recreate from the parent if absent now
			const abs = join(repo, file);
			if (!existsSync(abs) && before !== null) {
				writeFileSync(abs, before);
				result.filesChanged.push(file);
			} else if (before === null) {
				result.conflicts.push(file);
			}
			continue;
		}
		if (before === null) {
			result.conflicts.push(`${file} (baseline content evicted)`);
			continue;
		}
		const beforeLines = splitLinesLocal(before);
		const afterLines = splitLinesLocal(after);
		const abs = join(repo, file);
		if (!existsSync(abs)) {
			result.conflicts.push(`${file} (missing from the working tree)`);
			continue;
		}
		const current = readFileSync(abs, "utf8");
		const currentLines = splitLinesLocal(current);
		const hunks = computeHunks(beforeLines, afterLines);
		let changed = false;
		for (const h of [...hunks].sort((a, b) => b.insStart - a.insStart)) {
			const inserted = afterLines.slice(h.insStart, h.insStart + h.insCount);
			const replacement = beforeLines.slice(h.delStart, h.delStart + h.delCount);
			const at = findSequence(currentLines, inserted, h.insStart);
			if (at === null) {
				result.conflicts.push(`${file} hunk@${h.insStart + 1} (inserted lines not found verbatim)`);
				continue;
			}
			if (replacement.length === inserted.length && replacement.every((l, i) => l === currentLines[at + i])) continue;
			currentLines.splice(at, inserted.length, ...replacement);
			changed = true;
		}
		if (changed) {
			writeFileSync(abs, currentLines.length === 0 ? "" : currentLines.join("\n") + (current.endsWith("\n") || current === "" ? "\n" : ""));
			result.filesChanged.push(file);
		}
	}
	result.ok = result.conflicts.length === 0;
	return result;
}

/** Exact-sequence search anchored at `prefer`, drifting outward. */
function findSequence(haystack: string[], needle: string[], prefer: number): number | null {
	if (needle.length === 0) return null;
	for (let d = 0; d < haystack.length; d++) {
		for (const start of [prefer + d, prefer - d]) {
			if (start < 0 || start + needle.length > haystack.length) continue;
			let match = true;
			for (let i = 0; i < needle.length; i++) {
				if (stripCr(haystack[start + i]) !== stripCr(needle[i])) {
					match = false;
					break;
				}
			}
			if (match) return start;
		}
		if (prefer + d > haystack.length && prefer - d < 0) break;
	}
	return null;
}

function stripCr(s: string): string {
	return s.endsWith("\r") ? s.slice(0, -1) : s;
}

function splitLinesLocal(s: string): string[] {
	if (s.length === 0) return [];
	const lines = s.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

async function showOrNull(repo: string, sha: string, file: string): Promise<string | null> {
	try {
		const { stdout } = await exec("git", ["show", `${sha}:${file}`], { cwd: repo, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" });
		return (stdout as unknown as Buffer).toString("utf8");
	} catch {
		return null;
	}
}
