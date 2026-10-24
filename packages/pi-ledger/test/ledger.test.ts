import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commitLedger, buildLedgerNote, renderLedgerNote, parseLedgerNote, formatRangeTotals, recordTurnUsage, readLedgerUsage } from "../src/ledger.ts";
import { git, makeTempRepo } from "./helpers.ts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function syntheticUsage(ts: string, turn: number, cost: number): Awaited<ReturnType<typeof readLedgerUsage>>[number] {
	return {
		ts,
		turn,
		sessionId: "sess-ledger-1",
		model: "claude-test-4",
		provider: "test",
		input: 1000,
		output: 500,
		cacheRead: 0,
		cacheWrite: 0,
		costUsd: cost,
	};
}

function syntheticEvent(ts: string, file: string, turn: number): Parameters<typeof commitLedger>[0]["events"][number] {
	return { ts, file, author: "agent", source: "pi-edit", agent: { sessionId: "sess-ledger-1", turn, toolCallId: `call_${turn}`, model: "claude-test-4" } };
}

test("usage recording round-trips through the store", () => {
	const repo = makeTempRepo();
	const storeDir = join(repo, ".git", "coedit");
	recordTurnUsage(storeDir, "sess-ledger-1", syntheticUsage("2026-10-24T10:00:00.000Z", 0, 0.01));
	recordTurnUsage(storeDir, "sess-ledger-1", syntheticUsage("2026-10-24T10:01:00.000Z", 1, 0.02));
	const usage = readLedgerUsage(storeDir);
	assert.equal(usage.length, 2);
	assert.equal(usage[1].costUsd, 0.02);
});

test("synthetic session + commit -> post-commit hook writes the expected note", () => {
	const repo = makeTempRepo();
	writeFileSync(join(repo, "a.js"), "const x = 1;\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);

	// Timestamps must fall AFTER the init commit (which is created now), so the
	// hook's since-previous-commit window includes them.
	const t0 = new Date(Date.now() + 1_000).toISOString();
	const t1 = new Date(Date.now() + 6_000).toISOString();
	const storeDir = join(repo, ".git", "coedit");
	mkdirSync(storeDir, { recursive: true });
	recordTurnUsage(storeDir, "sess-ledger-1", syntheticUsage(t0, 0, 0.0125));
	writeFileSync(join(storeDir, "events.jsonl"), `${JSON.stringify(syntheticEvent(t1, "a.js", 0))}\n`);

	writeFileSync(join(repo, "a.js"), "const x = 1;\nconst y = 2;\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "feat: y"]);

	// Run the real hook entry against the fixture repo.
	const hook = spawnSync(process.execPath, [join(SRC, "hook.ts")], { cwd: repo, encoding: "utf8" });
	assert.equal(hook.status, 0, `hook failed: ${hook.stderr}`);

	const noteText = git(repo, ["notes", "--ref=pi-ledger", "show", "HEAD"]);
	const note = parseLedgerNote(noteText);
	assert.equal(note.schema, "pi-ledger/1");
	assert.equal(note.sessions.length, 1);
	assert.equal(note.sessions[0].sessionId, "sess-ledger-1");
	assert.equal(note.sessions[0].tokensIn, 1000);
	assert.equal(note.sessions[0].tokensOut, 500);
	assert.equal(note.sessions[0].costUsd, 0.0125);
	assert.equal(note.sessions[0].models[0], "claude-test-4");
	assert.equal(note.edits.length, 1);
	assert.equal(note.edits[0].toolCallId, "call_0");
	assert.equal(note.lines.source, null); // no git-ai note in the fixture
});

test("commitLedger scopes usage and edits to the window since the previous commit", () => {
	const events = [
		syntheticEvent("2026-10-24T09:00:00.000Z", "a.js", 0), // before the window
		syntheticEvent("2026-10-24T11:00:00.000Z", "a.js", 1), // inside
		syntheticEvent("2026-10-24T11:00:01.000Z", "b.js", 1), // uncommitted file
	];
	// commitLedger with a temp usage dir: write usage to a temp store first.
	const repo = makeTempRepo();
	const realStore = join(repo, ".git", "coedit");
	recordTurnUsage(realStore, "s", syntheticUsage("2026-10-24T09:30:00.000Z", 0, 0.001));
	recordTurnUsage(realStore, "s", syntheticUsage("2026-10-24T10:30:00.000Z", 1, 0.004));
	const note = commitLedger({
		storeDir: realStore,
		commit: "c",
		committedFiles: ["a.js"],
		events,
		sinceIso: "2026-10-24T10:00:00.000Z",
	});
	assert.equal(note.sessions.length, 1);
	assert.equal(note.sessions[0].costUsd, 0.004); // only post-window usage
	assert.equal(note.edits.length, 1); // only a.js edit inside the window
	assert.equal(note.edits[0].toolCallId, "call_1");
});

test("note build + range totals format", () => {
	const n1 = buildLedgerNote({
		commit: "a".repeat(40),
		usage: [syntheticUsage("2026-10-24T10:00:00.000Z", 0, 0.01)],
		edits: [{ toolCallId: "call_0", turn: 0, tool: "pi-edit", files: ["a.js"] }],
		agentLines: 12,
		humanLines: 3,
	});
	const n2 = buildLedgerNote({
		commit: "b".repeat(40),
		usage: [syntheticUsage("2026-10-24T11:00:00.000Z", 1, 0.02)],
		edits: [],
		agentLines: null,
		humanLines: null,
	});
	const text = renderLedgerNote(n1);
	const round = parseLedgerNote(text);
	assert.equal(round.sessions[0].costUsd, 0.01);
	assert.equal(round.lines.agent, 12);
	const summary = formatRangeTotals([n1, n2]);
	assert.match(summary, /2 commit\(s\)/);
	assert.match(summary, /\$0\.0300/);
	assert.match(summary, /claude-test-4/);
});
