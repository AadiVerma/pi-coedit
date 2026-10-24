import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoeditEvent, EventSource, Hunk } from "../src/types.ts";

export function makeTempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "coedit-test-"));
	git(dir, ["init", "-b", "main"]);
	git(dir, ["config", "user.name", "Test Human"]);
	git(dir, ["config", "user.email", "human@example.com"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	return dir;
}

export function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", args, { cwd, input, encoding: "utf8" });
}

export function writeFile(dir: string, rel: string, content: string): void {
	writeFileSync(join(dir, rel), content);
}

let seq = 0;
export function makeEvent(partial: {
	file: string;
	author: CoeditEvent["author"];
	source?: EventSource;
	beforeHash?: string | null;
	afterHash?: string | null;
	hunks?: Hunk[];
	binary?: boolean;
	agent?: CoeditEvent["agent"];
}): CoeditEvent {
	seq++;
	return {
		id: `ev${String(seq).padStart(4, "0")}`,
		ts: new Date(2026, 0, 1, 12, 0, seq).toISOString(),
		worktree: "/wt",
		file: partial.file,
		author: partial.author,
		source: partial.source ?? (partial.author === "agent" ? "pi-edit" : "editor"),
		beforeHash: partial.beforeHash !== undefined ? partial.beforeHash : "b".repeat(64),
		afterHash: partial.afterHash !== undefined ? partial.afterHash : "a".repeat(64),
		binary: partial.binary,
		hunks: partial.hunks ?? [],
		agent: partial.agent,
	};
}

export function hunk(delStart: number, delCount: number, insStart: number, insCount: number): Hunk {
	return { delStart, delCount, insStart, insCount };
}
