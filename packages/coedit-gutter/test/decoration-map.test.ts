import { test } from "node:test";
import assert from "node:assert/strict";
import { counts, mapAttributionToRanges, nextAgentLine, overlayUnsaved, prevAgentLine } from "../src/decoration-map.ts";
import type { FileAttribution, LineOrigin } from "@coedit/core";

function attr(origins: LineOrigin[]): FileAttribution {
	return { file: "a.ts", baseline: null, lines: origins.map((origin) => ({ origin, events: [] })) };
}

test("maps origins to ranges (0-based)", () => {
	const r = mapAttributionToRanges(attr(["unchanged", "human", "agent", "both", "unknown"]), 5, true);
	assert.deepEqual(r.human, [1]);
	assert.deepEqual(r.agent, [2]);
	assert.deepEqual(r.both, [3]);
	assert.deepEqual(r.unknown, [4]);
});

test("no attribution and no events -> no decorations", () => {
	const r = mapAttributionToRanges(undefined, 10, false);
	assert.deepEqual(r.human, []);
	assert.deepEqual(r.agent, []);
});

test("lines past the attribution array are unknown when the file has events", () => {
	const r = mapAttributionToRanges(attr(["agent"]), 3, true);
	assert.deepEqual(r.agent, [0]);
	assert.deepEqual(r.unknown, [1, 2]);
});

test("binary files get no decorations", () => {
	const r = mapAttributionToRanges({ file: "x", baseline: null, binary: true, lines: [] }, 4, true);
	assert.deepEqual({ ...r }, { human: [], agent: [], both: [], unknown: [] });
});

test("unsaved human overlay takes precedence and shifts agent lines", () => {
	const r = mapAttributionToRanges(attr(["unchanged", "agent", "agent"]), 3, true);
	const overlay = overlayUnsaved(r, new Set([1]));
	assert.deepEqual(overlay.human, [1]);
	assert.deepEqual(overlay.agent, [2]);
});

test("next/prev agent line navigation wraps around", () => {
	const r = mapAttributionToRanges(attr(["agent", "unchanged", "both", "unchanged"]), 4, true);
	assert.equal(nextAgentLine(r, 0), 0);
	assert.equal(nextAgentLine(r, 1), 2);
	assert.equal(nextAgentLine(r, 3), 0); // wrap
	assert.equal(prevAgentLine(r, 0), 0); // at or before
	assert.equal(prevAgentLine(r, -1), 2); // wrap (cursor on agent line 0)
	assert.equal(prevAgentLine(r, 3), 2);
	assert.equal(prevAgentLine(r, 1), 0);
});

test("counts merge both into agent for the status bar", () => {
	const r = mapAttributionToRanges(attr(["human", "agent", "both"]), 3, true);
	assert.deepEqual(counts(r), { human: 1, agent: 2 });
});
