import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitLedger, formatNoteSummary, formatRangeTotals, parseLedgerNote, readLedgerUsage, recordTurnUsage } from "../src/ledger.ts";
import { git, makeTempRepo } from "./helpers.ts";

function usage(ts: string, cost: number, session = "s1") {
	return { ts, turn: 0, sessionId: session, model: "m", provider: "p", input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: cost };
}

test("EDGE ledger: since-window comparison is correct across UTC offsets", () => {
	const repo = makeTempRepo();
	const store = join(repo, ".git", "coedit");
	// usage at 10:00Z; previous commit "time" expressed in three different offsets,
	// all representing 09:00Z — the window must include the usage in every case.
	for (const offset of ["+05:30", "-08:00", "Z"]) {
		const h = offset === "Z" ? "09:00:00" : offset === "+05:30" ? "14:30:00" : "01:00:00";
		const sinceIso = `2026-10-24T${h}${offset}`;
		const note = commitLedger({
			storeDir: store,
			commit: "c",
			committedFiles: ["a.js"],
			events: [{ ts: "2026-10-24T09:30:00.000Z", file: "a.js", author: "agent", source: "pi-edit", agent: { sessionId: "s1", turn: 0, toolCallId: "t1" } }],
			sinceIso,
		});
		void note;
	}
	// now with a real store: usage 09:30Z must survive all three offset spellings
	mkdirSync(store, { recursive: true });
	recordTurnUsage(store, "s1", usage("2026-10-24T09:30:00.000Z", 0.01));
	const raw = JSON.parse(readFileSync(join(store, "ledger", "s1.jsonl"), "utf8"));
	assert.equal(raw.costUsd, 0.01);
	for (const offset of ["+05:30", "-08:00", "Z"]) {
		const h = offset === "Z" ? "09:00:00" : offset === "+05:30" ? "14:30:00" : "01:00:00";
		const note = commitLedger({
			storeDir: store,
			commit: "c",
			committedFiles: ["a.js"],
			events: [],
			sinceIso: `2026-10-24T${h}${offset}`,
		});
		assert.equal(note.sessions.length, 1, `offset ${offset}: usage inside the window`);
		assert.equal(note.sessions[0].costUsd, 0.01);
		// and excluded when the window starts AFTER the usage (11:00Z in each offset spelling)
		const h2 = offset === "Z" ? "11:00:00" : offset === "+05:30" ? "16:30:00" : "03:00:00";
		const note2 = commitLedger({ storeDir: store, commit: "c", committedFiles: ["a.js"], events: [], sinceIso: `2026-10-24T${h2}${offset}` });
		assert.equal(note2.sessions.length, 0, `offset ${offset}: usage outside the window`);
	}
});

test("EDGE ledger: torn usage files and malformed notes do not crash reads", () => {
	const repo = makeTempRepo();
	const store = join(repo, ".git", "coedit");
	recordTurnUsage(store, "a", usage("2026-10-24T10:00:00.000Z", 0.01));
	writeFileSync(join(store, "ledger", "b.jsonl"), '{"ts":"2026-10-24T10:01:00.000Z"\n{"ts":"2026-10-24T10:02:00.000Z","turn":0,"sessionId":"b","model":"m","provider":"p","input":1,"output":1,"cacheRead":0,"cacheWrite":0,"costUsd":0.02}\n');
	const allUsage = readLedgerUsage(store);
	assert.equal(allUsage.length, 2); // torn line skipped, good line kept
	assert.ok(allUsage.some((u) => u.sessionId === "b"));
});

test("EDGE ledger: multi-session aggregation and rounding", () => {
	const note = {
		schema: "pi-ledger/1" as const,
		commit: "c",
		ts: "t",
		sessions: [
			{ sessionId: "s1", models: ["m1"], tokensIn: 1500, tokensOut: 500, costUsd: 0.0125 },
			{ sessionId: "s2", models: ["m2", "m1"], tokensIn: 500, tokensOut: 2500, costUsd: 0.0375 },
		],
		edits: [{ toolCallId: "t1", turn: 0, tool: "pi-edit", files: ["a.js"] }],
		lines: { agent: 7, human: 2, source: "git-ai" as const },
	};
	const summary = formatNoteSummary(note);
	assert.match(summary, /2 session\(s\), 1 agent edit\(s\)/);
	assert.match(summary, /lines: 🤖 7 agent · ✍️ 2 human \(via git-ai\)/);
	const totals = formatRangeTotals([note, note]);
	assert.match(totals, /\$0\.1000/); // (0.0125+0.0375)*2
	assert.match(totals, /2 commit\(s\)/);
});

test("EDGE ledger: parse rejects garbage loudly; commitLedger tolerates unknown authors", () => {
	assert.throws(() => parseLedgerNote("not json"));
	const note = commitLedger({
		storeDir: "/tmp/does-not-exist-ledger",
		commit: "c",
		committedFiles: [],
		events: [{ ts: "t", file: "a", author: "human", source: "editor" }, { ts: "t", file: "a", author: "agent", source: "pi-edit" }],
		sinceIso: null,
	});
	// human/editor events contribute no edit entries; agent events without toolCallId are skipped
	assert.equal(note.edits.length, 0);
	assert.equal(note.sessions.length, 0); // no usage dir → empty, not a crash
});
