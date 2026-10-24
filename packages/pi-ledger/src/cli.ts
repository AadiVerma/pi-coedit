/**
 * pi-ledger CLI: show / blame / range / report (+ install).
 * Reads git notes on refs/notes/pi-ledger written by the post-commit hook.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseLedgerNote, formatNoteSummary, formatRangeTotals, LEDGER_NOTES_REF, type LedgerNote } from "./ledger.ts";

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function noteFor(commit: string): LedgerNote | null {
	try {
		return parseLedgerNote(git(["notes", `--ref=${LEDGER_NOTES_REF}`, "show", commit]));
	} catch {
		return null;
	}
}

function commitsInRange(range: string): string[] {
	return git(["rev-list", range]).trim().split("\n").filter(Boolean);
}

function install(): void {
	const hookPath = join(git(["rev-parse", "--git-dir"]).trim(), "hooks", "post-commit");
	const marker = "# pi-ledger post-commit";
	// When running bundled, hook.js sits next to cli.js; from a source checkout, run hook.ts.
	const here = import.meta.dirname;
	const hookRuntime = existsSync(join(here, "hook.js")) ? join(here, "hook.js") : join(here, "hook.ts");
	const invocation = `${marker}\nnode "${hookRuntime}" "$@"\n`;
	mkdirSync(dirname(hookPath), { recursive: true });
	if (existsSync(hookPath)) {
		const existing = readFileSync(hookPath, "utf8");
		if (existing.includes(marker)) {
			console.log("pi-ledger: post-commit hook already installed");
			return;
		}
		// Chain after the existing hook — never overwrite it.
		appendFileSync(hookPath, `\n${invocation}`);
	} else {
		writeFileSync(hookPath, `#!/bin/sh\n${invocation}`);
	}
	chmodSync(hookPath, 0o755);
	console.log(`pi-ledger: installed post-commit hook at ${hookPath} (existing hooks were chained, not replaced)`);
}

function main(): void {
	const [, , cmd, ...args] = process.argv;
	if (!cmd || cmd === "help" || cmd === "--help") {
		console.log("usage: pi-ledger show [<commit>] | blame <file> | range <base>..<head> | report --since 30d [--json] | install");
		process.exit(cmd ? 0 : 1);
	}
	if (cmd === "install") {
		install();
		return;
	}
	if (cmd === "show") {
		const commit = args[0] ?? "HEAD";
		const sha = git(["rev-parse", commit]).trim();
		const note = noteFor(sha);
		console.log(note ? formatNoteSummary(note) : `pi-ledger: no note for ${sha.slice(0, 10)} (was the hook installed when it was committed?)`);
		return;
	}
	if (cmd === "blame") {
		const file = args[0];
		if (!file) {
			console.error("usage: pi-ledger blame <file>");
			process.exit(1);
		}
		const commits = git(["log", "--format=%H", "--", file]).trim().split("\n").filter(Boolean);
		let any = false;
		for (const sha of commits.reverse()) {
			const note = noteFor(sha);
			if (!note) continue;
			any = true;
			const edits = note.edits.filter((e) => e.files.includes(normalize(file)));
			console.log(`${sha.slice(0, 10)} — ${edits.length} agent edit(s) touching ${file}`);
			for (const e of edits) console.log(`  turn ${e.turn} via ${e.tool}`);
			if (note.lines.agent !== null) console.log(`  lines: 🤖 ${note.lines.agent} · ✍️ ${note.lines.human ?? "?"} (${note.lines.source})`);
			for (const s of note.sessions) console.log(`  ${s.models.join("+")} ↑${s.tokensIn} ↓${s.tokensOut} $${s.costUsd.toFixed(4)}`);
		}
		if (!any) console.log(`pi-ledger: no ledger notes mention ${file}`);
		return;
	}
	if (cmd === "range") {
		const range = args[0] ?? "HEAD";
		const notes = commitsInRange(range).map(noteFor).filter((n): n is LedgerNote => n !== null);
		console.log(notes.length > 0 ? formatRangeTotals(notes) : `pi-ledger: no notes under ${range}`);
		return;
	}
	if (cmd === "report") {
		const sinceIdx = args.indexOf("--since");
		const since = sinceIdx >= 0 ? parseSince(args[sinceIdx + 1] ?? "30d") : 30 * 86_400_000;
		const json = args.includes("--json");
		const shas = git(["rev-list", "HEAD"]).trim().split("\n").filter(Boolean);
		const notes: LedgerNote[] = [];
		for (const sha of shas) {
			const note = noteFor(sha);
			if (note && new Date(note.ts).getTime() > Date.now() - since) notes.push(note);
		}
		if (json) {
			console.log(JSON.stringify(notes, null, 2));
			return;
		}
		console.log(notes.length > 0 ? formatRangeTotals(notes) : "pi-ledger: no notes in the report window");
		return;
	}
	console.error(`pi-ledger: unknown command ${cmd}`);
	process.exit(1);
}

function normalize(p: string): string {
	return p.split("\\").join("/").replace(/^\.\//, "");
}

function parseSince(s: string): number {
	const m = /^(\d+)(d|w|h|m)$/.exec(s);
	if (!m) return 30 * 86_400_000;
	const n = Number(m[1]);
	return n * { d: 86_400_000, w: 7 * 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as "d" | "w" | "h" | "m"];
}

main();
