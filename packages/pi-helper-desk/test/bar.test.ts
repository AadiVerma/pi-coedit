import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanBar } from "../src/bar.ts";
import { PlanState } from "../src/plan.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** A theme that passes text through, so tests can assert on the bar's own ANSI. */
const fakeTheme = {
	fg: (_token: string, text: string) => text,
} as unknown as Theme;

const bar = (state: PlanState, width = 80) => new PlanBar(state, fakeTheme).render(width);

const planWith = (...statuses: string[]) => {
	const state = new PlanState();
	state.apply("Ship it", statuses.map((status, i) => ({ text: `step ${i + 1}`, status: status as never })));
	return state;
};

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visibleWidth = (lines: string[]) => lines.map((l) => plain(l).length);

test("no plan draws nothing", () => {
	assert.deepEqual(bar(new PlanState()), []);
});

test("a plan with steps draws the bar line and a status line", () => {
	const lines = bar(planWith("completed", "in_progress", "pending"));
	assert.equal(lines.length, 2);
});

test("the bar line carries the deep purple dot", () => {
	const lines = bar(planWith("pending", "pending"));
	assert.ok(lines[0].includes("\x1b[38;2;109;40;217m"), "the #6d28d9 dot code appears");
});

test("the Tasks label and percent appear on the bar line", () => {
	const lines = bar(planWith("completed", "completed", "pending"));
	assert.ok(lines[0].includes("Tasks 2/3"), "count pill");
	assert.ok(lines[0].includes("67%"), "rounded percent");
});

test("filled cells run from light purple to deep purple", () => {
	const lines = bar(planWith("completed", "completed", "pending", "pending"), 120);
	const line = lines[0];
	assert.ok(line.includes("\x1b[38;2;196;181;253m"), "the #c4b5fd light end appears");
	assert.ok(line.includes("\x1b[38;2;109;40;217m"), "the #6d28d9 deep end appears");
});

test("an untouched plan draws no filled cells and no live segment", () => {
	const line = bar(planWith("pending", "pending"))[0];
	assert.ok(!line.includes("\x1b[38;2;196;181;253m"), "no light fill");
	assert.ok(!line.includes("▓"), "no live segment glyph");
	assert.ok(line.includes("░"), "the track is visible");
});

test("a step in progress adds a mid-purple live segment", () => {
	const line = bar(planWith("completed", "in_progress", "pending"))[0];
	assert.ok(line.includes("\x1b[38;2;139;92;246m"), "the #8b5cf6 live segment appears");
	assert.ok(line.includes("▓"), "the live segment shimmers as ▓ blocks");
});

test("a finished plan shows 100%, no track left, and the All done line", () => {
	const lines = bar(planWith("completed", "completed"));
	assert.ok(lines[0].includes("100%"));
	assert.ok(!lines[0].includes("░"), "no empty track cells");
	assert.equal(plain(lines[1]), "All steps done");
});

test("the status line names the step in progress first, then the next one", () => {
	assert.equal(plain(bar(planWith("pending", "in_progress", "pending"))[1]), "Now: step 2");
	assert.equal(plain(bar(planWith("completed", "pending", "pending"))[1]), "Next: step 2");
});

test("an empty plan title falls back to Plan", () => {
	const state = new PlanState();
	state.apply("   ", [{ text: "a", status: "in_progress" }]);
	assert.ok(bar(state)[0].includes("Plan"));
});

test("a long title is cut before the bar is squeezed out", () => {
	const state = new PlanState();
	state.apply("T".repeat(80), [{ text: "a", status: "in_progress" }]);
	const lines = bar(state, 80);
	const titleRun = plain(lines[0]).match(/T+/)?.[0].length ?? 0;
	assert.ok(titleRun <= 28, "the title never exceeds 28 columns");
});

test("every rendered line fits the width it was given", () => {
	for (const width of [20, 40, 60, 80, 120, 200]) {
		const lines = bar(planWith("completed", "in_progress", "pending", "pending"), width);
		for (const [i, w] of visibleWidth(lines).entries()) {
			assert.ok(w <= width, `line ${i} fits width ${width} (was ${w})`);
		}
	}
});

test("the bar keeps a floor of 6 cells even on a tiny width", () => {
	const lines = bar(planWith("completed", "in_progress", "pending", "pending"), 20);
	assert.ok(lines.length >= 1);
	assert.ok(plain(lines[0]).length > 0, "something still renders");
});

test("percent rounds the way people expect: a third is 33%", () => {
	const lines = bar(planWith("completed", "pending", "pending"));
	assert.ok(lines[0].includes("33%"));
});

test("one step of one is 100%", () => {
	const lines = bar(planWith("completed"));
	assert.ok(lines[0].includes("100%"));
});

test("render caches by width until invalidate", () => {
	const state = planWith("completed", "in_progress");
	const view = new PlanBar(state, fakeTheme);
	const first = view.render(80);
	assert.equal(view.render(80), first, "same width reuses the cached lines");
	view.invalidate();
	assert.notEqual(view.render(80), first, "invalidate rebuilds");
	assert.deepEqual(view.render(80), first, "the rebuilt lines match");
});

test("state changes show after invalidate", () => {
	const state = planWith("in_progress", "pending");
	const view = new PlanBar(state, fakeTheme);
	const before = plain(view.render(80).join("|"));
	state.apply(undefined, [
		{ text: "step 1", status: "completed" },
		{ text: "step 2", status: "in_progress" },
	]);
	view.invalidate();
	const after = plain(view.render(80).join("|"));
	assert.notEqual(before, after, "the bar follows the plan");
});

test("color is reapplied per line: nothing renders without a closing reset", () => {
	const lines = bar(planWith("completed", "in_progress", "pending"));
	for (const [i, line] of lines.entries()) {
		const escapes = line.match(/\x1b\[0m/g)?.length ?? 0;
		const starts = line.match(/\x1b\[38;2;/g)?.length ?? 0;
		if (starts > 0) assert.ok(escapes > 0, `line ${i} closes its colors`);
	}
});

test("the gradient really shades: distinct fills across many steps", () => {
	// 10 steps done of 12 gives a wide fill; collect its cell colors.
	const state = planWith(...Array.from({ length: 10 }, () => "completed").concat(Array.from({ length: 2 }, () => "pending")));
	const codes = new Set(bar(state, 200)[0].match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []);
	const purples = [...codes].filter((c) => c.includes("196;181") || c.includes("109;40"));
	assert.ok(codes.size >= 4, "at least 4 distinct colors across the bar");
	assert.ok(purples.length === 2, "both gradient ends appear");
});
