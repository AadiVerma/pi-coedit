import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { HelperStore } from "../src/helpers.ts";
import { HelpersPane } from "../src/pane.ts";
import { PlanBar } from "../src/bar.ts";
import { PlanState } from "../src/plan.ts";
import { HUES, PET_COLS, PET_ROWS, nextFrame, piPet, pickHue } from "../src/pet.ts";
import { describe, KIND_COLOR, KINDS } from "../src/describe.ts";
import type { FeedItem } from "../src/types.ts";

const fakeTheme = { fg: (_t: string, s: string) => s } as unknown as Theme;
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---- Matrix: every hue at every frame renders a well-formed pet ----

for (const [hue, h] of HUES.entries()) {
	for (let frame = 0; frame < 4; frame++) {
		test(`pet hue ${h.name} frame ${frame} renders ${PET_ROWS} rows in its hue`, () => {
			const pet = piPet(hue, frame);
			assert.equal(pet.length, PET_ROWS);
			const body = `\x1b[38;2;${h.color.join(";")}m`;
			assert.ok(pet.join("\n").includes(body), "the body color appears");
			for (const line of pet) assert.ok(plain(line).length <= PET_COLS * 2 + 0, "fits the grid");
			assert.ok(pet.some((l) => plain(l).includes("█")), "the pet has pixels");
		});
	}
}

// ---- Matrix: pickHue from every starting point ----

for (let start = 0; start < 8; start++) {
	test(`pickHue from ${start} with nothing running hands out ${start}`, () => {
		assert.equal(pickHue(start, []), start);
	});
	test(`pickHue from ${start} skips the one running hue`, () => {
		const got = pickHue(start, [start]);
		assert.notEqual(got, start);
		assert.equal(got, (start + 1) % 8);
	});
}

// ---- Matrix: every status combination over three steps ----

const STATUSES = ["pending", "in_progress", "completed"] as const;
for (const a of STATUSES) {
	for (const b of STATUSES) {
		for (const c of STATUSES) {
			test(`plan [${a}, ${b}, ${c}] draws the right count, percent and status line`, () => {
				const state = new PlanState();
				state.apply("M", [
					{ text: "one", status: a },
					{ text: "two", status: b },
					{ text: "three", status: c },
				]);
				const done = [a, b, c].filter((s) => s === "completed").length;
				const lines = new PlanBar(state, fakeTheme).render(100);
				const bar = plain(lines[0]);
				assert.ok(bar.includes(`Tasks ${done}/3`));
				assert.ok(bar.includes(`${Math.round((done / 3) * 100)}%`));
				const live = [a, b, c].findIndex((s) => s === "in_progress");
				const statusLine = plain(lines[1]);
				if (live >= 0) assert.equal(statusLine, `Now: ${["one", "two", "three"][live]}`);
				else if (done === 3) assert.equal(statusLine, "All steps done");
				else assert.ok(statusLine.startsWith("Next: "));
			});
		}
	}
}

// ---- Matrix: widths from tiny to wide ----

for (let width = 24; width <= 160; width += 8) {
	test(`the bar and pane both fit width ${width}`, () => {
		const state = new PlanState();
		state.apply("A longer plan title for width sweeps", [
			{ text: "Read the brief carefully", status: "completed" },
			{ text: "Build the thing", status: "in_progress" },
			{ text: "Check", status: "pending" },
		]);
		const helpers = new HelperStore();
		helpers.spawn("a1", "A helper with a longer description for sweeps", 0);
		const feed: FeedItem[] = [{ id: "c1", kind: "Command", label: "Running: make all", done: false, at: 1 }];
		const barLines = new PlanBar(state, fakeTheme).render(width);
		for (const line of barLines) assert.ok(plain(line).length <= width, `bar fits ${width}`);
		const paneLines = new HelpersPane({ state, helpers, feed, theme: fakeTheme, done: () => {}, now: () => 0 }).render(width);
		for (const line of paneLines) assert.ok(plain(line).length <= width, `pane fits ${width}`);
	});
}

// ---- Matrix: the describe table, tool by tool ----

const TOOL_KINDS: [string, string][] = [
	["read", "File read"],
	["grep", "File read"],
	["find", "File read"],
	["ls", "File read"],
	["write", "File write"],
	["edit", "File write"],
	["bash", "Command"],
	["powershell", "Command"],
	["websearch", "Web"],
	["webfetch", "Web"],
	["agent", "Subagent"],
	["subagentworkflow", "Subagent"],
	["get_subagent_result", "Subagent"],
	["steer_subagent", "Subagent"],
	["plan", "Tool"],
	["skill", "Skill"],
	["mcp__notion__search", "Connector"],
	["mcp_notion_search", "Connector"],
	["codemode", "Tool"],
	["some_future_tool", "Tool"],
	["TODO", "Tool"],
];
for (const [tool, want] of TOOL_KINDS) {
	test(`describe("${tool}") is a ${want} step with a non-empty label`, () => {
		const d = describe(tool, {});
		assert.equal(d.kind, want);
		assert.ok(d.label.length > 0);
	});
}

test("every kind in the palette is reachable from at least one tool", () => {
	const reachable = new Set(TOOL_KINDS.map(([, k]) => k));
	for (const kind of KINDS) assert.ok(reachable.has(kind), `${kind} is reachable`);
	assert.deepEqual([...KINDS].sort(), Object.keys(KIND_COLOR).sort());
});

// ---- Matrix: nextFrame across a full minute ----

for (let ms = 0; ms < 60_000; ms += 5_000) {
	test(`nextFrame(${ms}) is frame ${Math.floor(ms / 600) % 4}`, () => {
		assert.equal(nextFrame(ms), Math.floor(ms / 600) % 4);
	});
}

// ---- Matrix: elapsed times across a full hour ----

for (const [seconds, want] of [
	[0, "0:00"],
	[1, "0:01"],
	[59, "0:59"],
	[60, "1:00"],
	[61, "1:01"],
	[3599, "59:59"],
	[3600, "60:00"],
	[3661, "61:01"],
] as const) {
	test(`elapsed ${seconds}s reads ${want}`, () => {
		const store = new HelperStore();
		const h = store.spawn("c1", "A", 0);
		assert.equal(HelperStore.elapsed(h, seconds * 1000), want);
	});
}
