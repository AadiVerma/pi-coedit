import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ReplayPane } from "../src/pane.ts";
import type { EditStep } from "../src/edits.ts";

const fakeTheme = { fg: (_t: string, s: string) => s } as unknown as Theme;
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const steps: EditStep[] = [
	{ path: "auth.ts", diff: "-1 old\n+1 new", at: 1000 },
	{ path: "readme.md", diff: "-2 gone\n+2 here", at: 2000 },
	{ path: "main.ts", diff: "-3 a\n+3 b", at: 3000 },
];

const make = (width = 80) => {
	let closed = 0;
	const pane = new ReplayPane(steps, fakeTheme, () => {
		closed += 1;
	});
	return { pane, closed: () => closed };
};

test("the pane opens on step 1 of N, with the file's name and diff", () => {
	const { pane } = make();
	const t = pane.render(80).map(plain).join("\n");
	assert.match(t, /auth\.ts/);
	assert.match(t, /-1 old/);
	assert.match(t, /\+1 new/);
	assert.match(t, /1 of 3/);
});

test("right and l move forward, left and h move back", () => {
	const { pane } = make();
	pane.handleInput("\x1b[C"); // right
	assert.match(pane.render(80).map(plain).join("\n"), /readme\.md/);
	pane.handleInput("l");
	assert.match(pane.render(80).map(plain).join("\n"), /main\.ts/);
	pane.handleInput("\x1b[D"); // left
	assert.match(pane.render(80).map(plain).join("\n"), /readme\.md/);
	pane.handleInput("h");
	assert.match(pane.render(80).map(plain).join("\n"), /auth\.ts/);
});

test("the step counter follows the position", () => {
	const { pane } = make();
	pane.handleInput("\x1b[C");
	assert.match(pane.render(80).map(plain).join("\n"), /2 of 3/);
});

test("at the edges the steps clamp, not wrap", () => {
	const { pane } = make();
	pane.handleInput("\x1b[D"); // left at step 1
	assert.match(pane.render(80).map(plain).join("\n"), /1 of 3/);
	pane.handleInput("\x1b[C");
	pane.handleInput("\x1b[C");
	pane.handleInput("\x1b[C"); // right past the end
	assert.match(pane.render(80).map(plain).join("\n"), /3 of 3/);
});

test("the diff shown changes with the step", () => {
	const { pane } = make();
	const first = plain(pane.render(80).join("\n"));
	pane.handleInput("\x1b[C");
	const second = plain(pane.render(80).join("\n"));
	assert.notEqual(first, second);
});

test("escape closes the pane", () => {
	const { pane, closed } = make();
	pane.handleInput("\x1b");
	assert.equal(closed(), 1);
});

test("q closes the pane too", () => {
	const { pane, closed } = make();
	pane.handleInput("q");
	assert.equal(closed(), 1);
});

test("unrelated keys do nothing", () => {
	const { pane, closed } = make();
	pane.handleInput("x");
	pane.handleInput("\t");
	assert.equal(closed(), 0);
	assert.match(pane.render(80).map(plain).join("\n"), /1 of 3/);
});

test("multi-line diffs render line by line, within the width", () => {
	const wide: EditStep[] = [{ path: "a.ts", diff: "-1 " + "x".repeat(120) + "\n+1 short", at: 0 }];
	const pane = new ReplayPane(wide, fakeTheme, () => {});
	for (const line of pane.render(60)) assert.ok(plain(line).length <= 60, `fits 60: ${plain(line).length}`);
});

test("an empty edit list still renders a graceful screen", () => {
	const pane = new ReplayPane([], fakeTheme, () => {});
	const t = pane.render(80).map(plain).join("\n");
	assert.match(t, /No file edits/);
});
