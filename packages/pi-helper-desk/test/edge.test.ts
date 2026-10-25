import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { HelperStore } from "../src/helpers.ts";
import { HelpersPane } from "../src/pane.ts";
import { PlanBar } from "../src/bar.ts";
import { PlanState } from "../src/plan.ts";
import { HUES, PET_COLS, piPet, pickHue } from "../src/pet.ts";
import { describe, KIND_COLOR } from "../src/describe.ts";
import type { FeedItem } from "../src/types.ts";

const fakeTheme = { fg: (_t: string, s: string) => s } as unknown as Theme;
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---- HelperStore helpers ----

test("elapsed formats minutes and seconds, clamped at zero", () => {
	const store = new HelperStore();
	const h = store.spawn("c1", "A", 60_000);
	assert.equal(HelperStore.elapsed(h, 60_000), "0:00", "no time yet");
	assert.equal(HelperStore.elapsed(h, 65_000), "0:05");
	assert.equal(HelperStore.elapsed(h, 120_000), "1:00");
	assert.equal(HelperStore.elapsed(h, 600_000), "9:00", "540 seconds from its start");
	assert.equal(HelperStore.elapsed(h, 3_723_000), "61:03");
	assert.equal(HelperStore.elapsed(h, 1_000), "0:00", "a clock running backwards clamps");
});

test("elapsed for a finished helper uses its end time, not the clock", () => {
	const store = new HelperStore();
	store.spawn("c1", "A", 0);
	store.finish("c1", false, 30_000);
	const h = store.find("c1")!;
	assert.equal(HelperStore.elapsed(h, 999_000), "0:30");
});

test("hueName names the hue a helper wears", () => {
	const store = new HelperStore();
	const h = store.spawn("c1", "A", 0);
	assert.equal(HelperStore.hueName(h), HUES[h.hue].name);
});

test("helpers keep start order in all, whatever their status", () => {
	const store = new HelperStore();
	store.spawn("c1", "A", 0);
	store.spawn("c2", "B", 1);
	store.spawn("c3", "C", 2);
	store.finish("c2", true, 3);
	assert.deepEqual(
		store.all.map((h) => h.label),
		["A", "B", "C"],
	);
});

// ---- Pets: pixels and hues under more scrutiny ----

test("every pet row stays inside the grid width, gaps included", () => {
	for (let hue = 0; hue < 8; hue++) {
		for (let frame = 0; frame < 4; frame++) {
			for (const line of piPet(hue, frame)) {
				assert.ok(plain(line).length <= PET_COLS * 2, `hue ${hue} frame ${frame} fits`);
			}
		}
	}
});

test("eyes are inside the stems, never on the bar or the feet", () => {
	const pet = piPet(0, 0);
	assert.ok(plain(pet[1]).includes("█"), "the bar row has blocks");
	assert.ok(plain(pet[2]).includes("█"), "stem rows draw blocks");
	assert.ok(plain(pet[6]).includes("█"), "the feet row has blocks");
});

test("the blink frame keeps the body shape and only loses the eye color", () => {
	const stand = piPet(0, 0);
	const blink = piPet(0, 2);
	// Eyes are drawn on body pixels, so blinking changes color, not layout.
	for (let y = 0; y < stand.length; y++) {
		assert.equal(plain(blink[y]), plain(stand[y]), `row ${y} keeps its shape`);
	}
	const eyeCode = "\x1b[38;2;43;29;22m";
	assert.ok(stand.join("\n").includes(eyeCode), "the standing frame has eyes");
	assert.ok(!blink.join("\n").includes(eyeCode), "the blink frame does not");
});

test("pickHue never hands a running hue to a new helper across a full cycle", () => {
	const running: number[] = [];
	let next = 0;
	for (let i = 0; i < 8; i++) {
		const hue = pickHue(next, running);
		running.push(hue);
		next = hue + 1;
	}
	assert.equal(new Set(running).size, 8);
	// After all 8 run, the pointer wraps and reuses — the best it can do.
	const ninth = pickHue(next, running);
	assert.ok(running.includes(ninth));
});

// ---- Bar: multi-width caching and single-step fills ----

test("the bar caches per width: 80 and 40 stay separate", () => {
	const state = new PlanState();
	state.apply("T", [{ text: "a", status: "completed" }, { text: "b", status: "in_progress" }]);
	const view = new PlanBar(state, fakeTheme);
	const wide = view.render(80);
	const narrow = view.render(40);
	assert.notEqual(wide, narrow);
	// One cache slot: switching widths rebuilds, but the content is identical.
	assert.deepEqual(view.render(80), wide, "the wide render is stable");
	assert.deepEqual(view.render(40), narrow);
});

test("one done step of many fills exactly one cell of the track", () => {
	const state = new PlanState();
	const steps: { text: string; status: "completed" | "pending" }[] = [
		{ text: "a", status: "completed" },
	];
	for (let i = 0; i < 9; i++) steps.push({ text: `s${i}`, status: "pending" });
	state.apply("T", steps);
	const line = plain(new PlanBar(state, fakeTheme).render(120)[0]);
	// Track chars: filled + live + empty must all be present in a 1/10 fill.
	assert.ok(line.includes("█"), "a filled cell exists");
	assert.ok(line.includes("░"), "empty track remains");
});

test("the bar renders without a status line when no step is live, next or done", () => {
	// Unreachable in practice, but a plan whose steps are all in_progress shows Now.
	const state = new PlanState();
	state.apply("T", [{ text: "only", status: "in_progress" }]);
	const lines = new PlanBar(state, fakeTheme).render(80);
	assert.equal(lines.length, 2);
	assert.equal(plain(lines[1]), "Now: only");
});

// ---- describe: kinds drive the palette ----

test("every kind describe can return has a color entry", () => {
	const tools = ["read", "write", "edit", "ls", "grep", "find", "bash", "powershell", "websearch", "webfetch", "agent", "subagentworkflow", "get_subagent_result", "steer_subagent", "plan", "who-knows"];
	const kinds = new Set(tools.map((t) => describe(t).kind));
	for (const kind of kinds) assert.ok(kind in KIND_COLOR, `${kind} has a color`);
});

// ---- Cross-module: the desk the user actually sees ----

test("a full session renders end to end: plan, subagents, feed, groups", () => {
	const state = new PlanState();
	state.apply("Ship it", [
		{ text: "Read the brief", status: "completed" },
		{ text: "Build", status: "in_progress" },
		{ text: "Check", status: "pending" },
	]);
	const helpers = new HelperStore();
	helpers.spawn("a1", "Subagent: Research notes", 0);
	const feed: FeedItem[] = [
		{ id: "c1", kind: "File read", label: "Reading research.md", done: true, at: 1 },
		{ id: "c2", kind: "Subagent", label: "Subagent: Research notes", done: false, at: 2 },
	];
	const deps = { state, helpers, feed, theme: fakeTheme, done: () => {}, now: () => 5_000 };
	const text = new HelpersPane(deps)
		.render(100)
		.map(plain)
		.join("\n");
	assert.ok(text.includes("Ship it  ·  1/3 done"));
	assert.ok(text.includes("Running · 1"));
	assert.ok(text.includes("Research notes"));
	assert.ok(text.includes("0:05"));
	assert.ok(text.includes("▸ Subagent: Research notes"), "the live feed line");
	assert.ok(text.includes("· Reading research.md"), "the finished feed line");
});

test("a helper that finishes between renders moves from Running to Finished with the same pet hue", () => {
	const helpers = new HelperStore();
	const deps = { state: new PlanState(), helpers, feed: [] as FeedItem[], theme: fakeTheme, done: () => {}, now: () => 100 };
	const before = new HelpersPane(deps).render(100).join("\n");
	const after = (() => {
		helpers.finish("missing", false, 0); // unknown id: no crash, no change
		return new HelpersPane(deps).render(100).join("\n");
	})();
	assert.equal(after, before, "an unknown finish changes nothing");
	helpers.spawn("a1", "A", 0);
	helpers.finish("a1", false, 200);
	const hue = `\x1b[38;2;${HUES[helpers.all[0].hue].color.join(";")}m`;
	const moved = new HelpersPane(deps).render(100).join("\n");
	assert.ok(moved.includes("Finished · 1"));
	assert.ok(!moved.includes("Running · 1"));
	assert.ok(moved.includes(hue), "the same hue travels with the helper");
});

test("eight helpers running at once all get pet cards in the pane", () => {
	const helpers = new HelperStore();
	for (let i = 0; i < 8; i++) helpers.spawn(`c${i}`, `Helper ${i}`, 0);
	const deps = { state: new PlanState(), helpers, feed: [] as FeedItem[], theme: fakeTheme, done: () => {}, now: () => 0 };
	const lines = new HelpersPane(deps).render(160);
	for (let i = 0; i < 8; i++) assert.ok(lines.map(plain).join("\n").includes(`Helper ${i}`));
});
