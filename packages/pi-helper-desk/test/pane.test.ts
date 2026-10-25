import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { HelpersPane, type PaneDeps } from "../src/pane.ts";
import { HelperStore } from "../src/helpers.ts";
import { PlanState } from "../src/plan.ts";
import { HUES } from "../src/pet.ts";
import type { FeedItem } from "../src/types.ts";

/** A theme that passes text through, so tests assert the pane's own ANSI codes. */
const fakeTheme = {
	fg: (_token: string, text: string) => text,
} as unknown as Theme;

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

interface Rig {
	deps: PaneDeps;
	helpers: HelperStore;
	feed: FeedItem[];
	state: PlanState;
	render: (width?: number) => string[];
	lines: string[];
	text: string;
	done: () => number;
}

const rig = (now = 10_000): Rig => {
	const state = new PlanState();
	const helpers = new HelperStore();
	const feed: FeedItem[] = [];
	let closed = 0;
	const deps: PaneDeps = {
		state,
		helpers,
		feed,
		theme: fakeTheme,
		done: () => {
			closed += 1;
		},
		now: () => now,
	};
	const render = (width = 100) => new HelpersPane(deps).render(width);
	const lines = render();
	return {
		deps,
		helpers,
		feed,
		state,
		render,
		lines,
		text: lines.map(plain).join("\n"),
		done: () => closed,
	};
};

const planWith = (state: PlanState, title: string, ...statuses: string[]) =>
	state.apply(title, statuses.map((status, i) => ({ text: `${title} step ${i + 1}`, status: status as never })));

/** Re-render the rig after mutating its state and return the plain text. */
const textOf = (r: Rig, width = 100) => r.render(width).map(plain).join("\n");

// ---- Structure ----

test("the pane opens with a Helper Desk header", () => {
	const { text } = rig();
	assert.ok(text.includes("Helper Desk"));
});

test("with no plan the pane says so", () => {
	const { text } = rig();
	assert.ok(text.includes("No plan yet"));
});

test("the plan shows its title and a done count", () => {
	const r = rig();
	planWith(r.state, "Ship it", "completed", "in_progress", "pending");
	const text = textOf(r);
	assert.ok(text.includes("Ship it"), "the title");
	assert.ok(text.includes("1/3 done"), "the count");
});

test("checklist marks: completed ticks, in progress dots, pending circles", () => {
	const r = rig();
	planWith(r.state, "Ship it", "completed", "in_progress", "pending");
	const text = textOf(r);
	assert.ok(text.includes("✓"), "a completed tick");
	assert.ok(text.includes("●"), "an in-progress dot");
	assert.ok(text.includes("○"), "a pending circle");
});

// ---- Subagent groups: the Claude colors ----

test("the Running group heading sits in a green (#16a34a) filled bar, with its count", () => {
	const r = rig();
	r.helpers.spawn("c1", "Build the landing page", 0);
	const lines = r.render();
	assert.ok(lines.some((l) => l.includes("\x1b[48;2;22;163;74m")), "green background");
	assert.ok(lines.some((l) => plain(l).includes("Running · 1")));
});

test("the Finished group heading sits in a yellow (#eab308) filled bar", () => {
	const r = rig();
	r.helpers.spawn("c1", "Research notes", 0);
	r.helpers.finish("c1", false, 4000);
	const lines = r.render();
	assert.ok(lines.some((l) => l.includes("\x1b[48;2;234;179;8m")), "yellow background");
	assert.ok(lines.some((l) => plain(l).includes("Finished · 1")));
});

test("the Stopped group heading sits in a red (#dc2626) filled bar", () => {
	const r = rig();
	r.helpers.spawn("c1", "Boom", 0);
	r.helpers.finish("c1", true, 4000);
	const lines = r.render();
	assert.ok(lines.some((l) => l.includes("\x1b[48;2;220;38;38m")), "red background");
	assert.ok(lines.some((l) => plain(l).includes("Stopped · 1")));
});

test("groups with no members draw no heading", () => {
	const { lines } = rig();
	assert.ok(!lines.some((l) => plain(l).includes("Running ·")));
	assert.ok(!lines.some((l) => plain(l).includes("Finished ·")));
	assert.ok(!lines.some((l) => plain(l).includes("Stopped ·")));
});

// ---- Pet cards ----

test("a running helper gets a card with its description and a pet in its own hue", () => {
	const r = rig();
	const h = r.helpers.spawn("c1", "Build the landing page", 0);
	const lines = r.render();
	const text = lines.map(plain).join("\n");
	assert.ok(text.includes("Build the landing page"), "the description");
	const hue = HUES[h.hue].color.join(";");
	assert.ok(lines.join("\n").includes(`\x1b[38;2;${hue}m`), `the ${HUES[h.hue].name} pet is drawn`);
});

test("a running helper's pet animates with the injected clock", () => {
	const helpers = new HelperStore();
	helpers.spawn("c1", "One", 0);
	const deps: PaneDeps = {
		state: new PlanState(),
		helpers,
		feed: [],
		theme: fakeTheme,
		done: () => {},
		now: () => 0,
	};
	const a = new HelpersPane(deps).render(100).join("\n");
	const b = new HelpersPane({ ...deps, now: () => 1500 }).render(100).join("\n");
	assert.notEqual(a, b, "the pet's frame moves as time passes");
});

test("a finished helper's pet stands still, frame 0, whatever the clock says", () => {
	const r = rig();
	r.helpers.spawn("c1", "One", 0);
	r.helpers.finish("c1", false, 100);
	const a = new HelpersPane({ ...r.deps, now: () => 10_000 }).render(100).join("\n");
	const b = new HelpersPane({ ...r.deps, now: () => 70_000 }).render(100).join("\n");
	assert.equal(a, b, "no animation after finishing");
});

test("a finished card shows a tick, a stopped card a cross, a running card a dot", () => {
	const r = rig();
	r.helpers.spawn("c1", "A", 0);
	r.helpers.spawn("c2", "B", 0);
	r.helpers.spawn("c3", "C", 0);
	r.helpers.finish("c1", false, 100);
	r.helpers.finish("c2", true, 100);
	const lines = r.render();
	const body = lines.join("\n");
	assert.ok(lines.some((l) => plain(l).includes("✓")), "done mark");
	assert.ok(lines.some((l) => plain(l).includes("✗")), "stopped mark");
	assert.ok(body.includes("●"), "running mark");
});

test("cards show elapsed time from the injected clock", () => {
	const r = rig();
	r.helpers.spawn("c1", "A", 5_000);
	const text = textOf(r); // now = 10_000
	assert.ok(text.includes("0:05"), "5 seconds elapsed");
});

test("eight helpers wear eight different pet colors", () => {
	const r = rig();
	for (let i = 0; i < 8; i++) r.helpers.spawn(`c${i}`, `H${i}`, 0);
	const lines = r.render();
	const colors = new Set(lines.join("\n").match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []);
	// 8 pet hues + dark eyes + red cross mark at minimum.
	assert.ok(colors.size >= 8, `found ${colors.size} colors`);
});

// ---- The step feed ----

test("tool steps show with a bullet: ▸ while running, · when done", () => {
	const r = rig();
	r.feed.push({ id: "f", kind: "File read", label: "Reading research.md", done: false, at: 1 });
	r.feed.push({ id: "f", kind: "Command", label: "List the temp folder", done: true, at: 2 });
	const text = textOf(r);
	assert.ok(text.includes("▸ Reading research.md"));
	assert.ok(text.includes("· List the temp folder"));
});

test("feed labels draw in their kind's color", () => {
	const r = rig();
	r.feed.push({ id: "f", kind: "File read", label: "Reading research.md", done: true, at: 1 });
	r.feed.push({ id: "f", kind: "Subagent", label: "Subagent: Research", done: true, at: 2 });
	const lines = r.render();
	const body = lines.join("\n");
	assert.ok(body.includes("\x1b[38;2;22;163;74m"), "File read green (#16a34a)");
	assert.ok(body.includes("\x1b[38;2;219;39;119m"), "Subagent pink (#db2777)");
});

test("an errored step is crossed out in red", () => {
	const r = rig();
	r.feed.push({ id: "f", kind: "Command", label: "Running: rm -rf /", done: true, error: true, at: 1 });
	const lines = r.render();
	const text = lines.map(plain).join("\n");
	assert.ok(text.includes("✗"), "the cross");
	assert.ok(lines.join("\n").includes("\x1b[38;2;220;38;38m"), "the red");
});

test("the feed shows only the last 8 steps", () => {
	const r = rig();
	for (let i = 1; i <= 12; i++) r.feed.push({ id: "f", kind: "Tool", label: `step ${i}`, done: true, at: i });
	const text = textOf(r);
	assert.ok(text.includes("step 12"));
	assert.ok(text.includes("step 5"));
	assert.ok(!text.includes("step 4"), "older steps fall off");
});

test("an empty feed explains itself", () => {
	const { text } = rig();
	assert.ok(text.includes("Tool calls show up here"));
});

// ---- Input and caching ----

test("escape closes the pane", () => {
	const r = rig();
	new HelpersPane(r.deps).handleInput("\x1b");
	assert.equal(r.done(), 1);
});

test("ctrl+c closes the pane", () => {
	const r = rig();
	new HelpersPane(r.deps).handleInput("\x03");
	assert.equal(r.done(), 1);
});

test("other keys do nothing", () => {
	const r = rig();
	const pane = new HelpersPane(r.deps);
	pane.handleInput("a");
	pane.handleInput("\r");
	pane.handleInput("\x1b[A");
	assert.equal(r.done(), 0);
});

test("render caches by width until invalidate", () => {
	const r = rig();
	const pane = new HelpersPane(r.deps);
	const first = pane.render(100);
	assert.equal(pane.render(100), first);
	pane.invalidate();
	assert.notEqual(pane.render(100), first);
	assert.deepEqual(pane.render(100), first);
});

test("every line fits the width it was given", () => {
	const r = rig();
	r.helpers.spawn("c1", "A fairly long helper description goes here for truncation", 0);
	planWith(r.state, "A very long plan title that must also truncate somewhere", "completed", "in_progress", "pending");
	for (const width of [40, 60, 100, 160]) {
		const pane = new HelpersPane(r.deps);
		for (const [i, line] of pane.render(width).entries()) {
			assert.ok(plain(line).length <= width, `line ${i} fits ${width} (was ${plain(line).length})`);
		}
	}
});

test("the pane ends with the escape hint", () => {
	const { text } = rig();
	assert.ok(text.includes("Press Escape to close"));
});
