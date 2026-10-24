import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHunks } from "@coedit/core";
import { computeAgentRevert, type RevertEvent } from "../src/revert-core.ts";

function ev(before: string, after: string): RevertEvent {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	return { hunks: computeHunks(beforeLines, afterLines), beforeLines, afterLines };
}

let executed = 0;

test("REVERT: single agent edit reverts exactly its own lines", () => {
	const original = ["one", "two", "three"];
	const afterAgent = ["one", "AGENT", "three"];
	const r = computeAgentRevert(afterAgent, [ev("one\ntwo\nthree", "one\nAGENT\nthree")]);
	assert.deepEqual(r.lines, original);
	assert.equal(r.changed, true);
	assert.equal(r.conflicts.length, 0);
	executed++;
});

test("REVERT: human lines survive; only agent hunks are undone", () => {
	const r = computeAgentRevert(["HUMAN-top", "AGENT", "shared", "AGENT2"], [
		ev("two\nshared\nfour", "AGENT\nshared\nAGENT2"),
		// (human's HUMAN-top line was added outside any recorded event)
	]);
	assert.deepEqual(r.lines, ["HUMAN-top", "two", "shared", "four"]);
	assert.equal(r.conflicts.length, 0);
	executed++;
});

test("REVERT: overlapping agent edits revert cleanly, newest first", () => {
	const r = computeAgentRevert(["base", "B2-rewrite"], [
		ev("base\nA1", "base\nA1-plus"), // older event created A1-plus
		ev("base\nA1-plus", "base\nB2-rewrite"), // newer event rewrote it
	]);
	assert.deepEqual(r.lines, ["base", "A1"]);
	assert.equal(r.conflicts.length, 0);
	executed++;
});

test("REVERT: human context drift does not block the revert", () => {
	// The human edited the line BELOW the agent hunk after the agent edit.
	const r = computeAgentRevert(["AGENT", "HUMAN-edited-lower"], [ev("orig\nlower", "AGENT\nlower")]);
	assert.deepEqual(r.lines, ["orig", "HUMAN-edited-lower"]);
	assert.equal(r.conflicts.length, 0);
	executed++;
});

test("REVERT: evicted content is a conflict, never a blind apply", () => {
	const r = computeAgentRevert(["x"], [{ hunks: [{ delStart: 0, delCount: 1, insStart: 0, insCount: 1 }], beforeLines: null, afterLines: ["x"] }]);
	assert.equal(r.changed, false);
	assert.equal(r.conflicts.length, 1);
	assert.match(r.conflicts[0], /evicted/);
	executed++;
});

test("REVERT: altered agent lines are conflicts (human rewrote the agent's line)", () => {
	const r = computeAgentRevert(["HUMAN-rewrote-the-agent-line", "keep"], [ev("orig\nkeep", "AGENT\nkeep")]);
	assert.equal(r.conflicts.length, 1);
	assert.match(r.conflicts[0], /not found verbatim/);
	executed++;
});

test("REVERT: range limits the revert to the selection", () => {
	const r = computeAgentRevert(["AGENT-top", "mid", "AGENT-bottom"], [
		ev("top\nmid\nbottom", "AGENT-top\nmid\nAGENT-bottom"),
	], { from: 2, to: 2 });
	assert.deepEqual(r.lines, ["AGENT-top", "mid", "bottom"]);
	assert.equal(r.skipped, 1);
	executed++;
});

test("REVERT: already-reverted content is a no-op", () => {
	const r = computeAgentRevert(["one", "two"], [ev("one\ntwo", "one\ntwo")]);
	assert.equal(r.changed, false);
	assert.equal(r.conflicts.length, 0);
	executed++;
});

test("REVERT: insertions and deletions at file edges", () => {
	const r1 = computeAgentRevert(["AGENT-inserted", "real"], [ev("real", "AGENT-inserted\nreal")]);
	assert.deepEqual(r1.lines, ["real"]);
	const r2 = computeAgentRevert(["real", "AGENT-appended"], [ev("real", "real\nAGENT-appended")]);
	assert.deepEqual(r2.lines, ["real"]);
	executed += 2;
});

test("REVERT: CRLF content reverts despite line-ending drift", () => {
	const r = computeAgentRevert(["AGENT\r", "keep\r"], [ev("orig\r\nkeep\r\n", "AGENT\r\nkeep\r\n")]);
	assert.deepEqual(r.lines.map(stripCrSafe), ["orig", "keep"]);
	executed++;
});

function stripCrSafe(s: string): string {
	return s.endsWith("\r") ? s.slice(0, -1) : s;
}

test("REVERT fuzz: 300 random event chains revert to the pre-agent content", { timeout: 60_000 }, () => {
	let seed = 12345;
	const rand = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	for (let iter = 0; iter < 300; iter++) {
		const base: string[] = [];
		const n = 1 + Math.floor(rand() * 12);
		for (let i = 0; i < n; i++) base.push(`L${i}`);
		// chain of agent edits, each derived from the previous content
		const events: RevertEvent[] = [];
		let current = [...base];
		const snapshots: string[][] = [[...current]];
		const k = 1 + Math.floor(rand() * 4);
		for (let e = 0; e < k; e++) {
			const next = [...current];
			const pos = Math.floor(rand() * (next.length + 1));
			next.splice(pos, rand() < 0.4 ? 1 : 0, `AGENT-${e}`);
			events.push(ev(current.join("\n"), next.join("\n")));
			current = next;
			snapshots.push([...current]);
		}
		// revert from the final content back to the original
		const r = computeAgentRevert(current, events);
		assert.deepEqual(r.lines, base, `iter#${iter}`);
		assert.equal(r.conflicts.length, 0, `iter#${iter}: ${r.conflicts.join("; ")}`);
		executed++;
	}
	console.log(`  revert tests executed ${executed} cases`);
});
