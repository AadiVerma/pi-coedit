/**
 * pi-ledger post-commit hook entry. Installed by `/ledger install` (or
 * `pi-ledger install`). Reads the coedit store + ledger usage for the repo and
 * writes a note on refs/notes/pi-ledger for the commit that just landed.
 * Chained after any existing hook; never pushes anything.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitLedger, renderLedgerNote, LEDGER_NOTES_REF } from "./ledger.ts";
import { parseGitAiNote } from "@coedit/core";

interface StoreEvent {
	ts: string;
	file: string;
	author: string;
	source: string;
	agent?: { sessionId: string; turn?: number; toolCallId?: string; model?: string; sessionFile?: string };
}

function git(args: string[], input?: string): string {
	return execFileSync("git", args, {
		cwd: process.cwd(),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		...(input !== undefined ? { input } : {}),
	});
}

function main(): void {
	const commit = git(["rev-parse", "HEAD"]).trim();
	const commonDirRaw = git(["rev-parse", "--git-common-dir"]).trim();
	const commonDir = commonDirRaw.startsWith("/") ? commonDirRaw : join(process.cwd(), commonDirRaw);
	const storeDir = join(commonDir, "coedit");
	if (!existsSync(join(storeDir, "events.jsonl"))) return; // coedit never used here

	const committedFiles = git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
		.trim()
		.split("\n")
		.filter(Boolean);
	const parents = git(["rev-list", "--parents", "-n", "1", commit]).trim().split(" ").slice(1);
	const previous = parents[0] ?? null;
	const sinceIso = previous ? git(["log", "-1", "--format=%cI", previous]).trim() : null;

	const events: StoreEvent[] = [];
	for (const line of readFileSync(join(storeDir, "events.jsonl"), "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line) as StoreEvent);
		} catch {
			/* torn tail */
		}
	}

	const note = commitLedger({ storeDir, commit, committedFiles, events, sinceIso });

	// Line attribution: link to Git AI's note when present instead of duplicating it.
	try {
		const aiNote = git(["notes", "--ref=ai", "show", commit]);
		const parsed = parseGitAiNote(aiNote);
		let agent = 0;
		let human = 0;
		for (const a of parsed.attestations) {
			if (!committedFiles.includes(a.file)) continue;
			const count = a.ranges
				.split(",")
				.reduce((n, r) => n + (r.includes("-") ? Number(r.split("-")[1]) - Number(r.split("-")[0]) + 1 : 1), 0);
			if (a.key.startsWith("s_") || /^[0-9a-f]{16}$/.test(a.key)) agent += count;
			else if (a.key.startsWith("h_")) human += count;
		}
		note.lines = { agent: agent > 0 ? agent : null, human: human > 0 ? human : null, source: agent + human > 0 ? "git-ai" : null };
	} catch {
		/* no git-ai note — lines stay null */
	}

	git(["notes", `--ref=${LEDGER_NOTES_REF}`, "add", "-f", "-F", "-", commit], renderLedgerNote(note));
}

try {
	main();
} catch (e) {
	// A reporting hook must never break commits; log quietly.
	console.error(`pi-ledger: ${(e as Error).message}`);
}
