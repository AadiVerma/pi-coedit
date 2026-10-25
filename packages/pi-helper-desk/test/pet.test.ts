import { test } from "node:test";
import assert from "node:assert/strict";
import { EYE, HUES, PET_COLS, PET_ROWS, nextFrame, piPet, pickHue } from "../src/pet.ts";

/** A line with its ANSI escapes stripped. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const bodyCells = (lines: string[]) =>
	lines.flatMap((line, y) => [...plain(line)].map((ch, x) => ({ ch, x, y })).filter((c) => c.ch !== " "));

test("there are 8 hues with the same names and hex colors as the Claude mod", () => {
	assert.equal(HUES.length, 8);
	assert.deepEqual(
		HUES.map((h) => h.name),
		["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"],
	);
	const hex = (rgb: number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
	assert.equal(hex(HUES[0].color), "#dc2626");
	assert.equal(hex(HUES[1].color), "#ea580c");
	assert.equal(hex(HUES[2].color), "#eab308");
	assert.equal(hex(HUES[3].color), "#16a34a");
	assert.equal(hex(HUES[4].color), "#0d9488");
	assert.equal(hex(HUES[5].color), "#2563eb");
	assert.equal(hex(HUES[6].color), "#9333ea");
	assert.equal(hex(HUES[7].color), "#db2777");
	assert.deepEqual(EYE, [0x2b, 0x1d, 0x16]);
});

test("a pet is a 12x6 pixel grid drawn as double-width blocks", () => {
	const pet = piPet(0, 0);
	assert.equal(pet.length, PET_ROWS);
	for (const line of pet) assert.ok(plain(line).length <= PET_COLS * 2, "row fits the pet width");
	const chars = bodyCells(pet);
	assert.ok(chars.length > 20, "the pet has a body");
	// Every drawn cell is a full block.
	assert.ok(chars.every((c) => c.ch === "█"), "pixels render as █ blocks");
});

test("the shape is a pi: a top bar across and two stems down", () => {
	const hop = piPet(0, 1); // mid-hop the pet sits at the top of its grid
	// Top bar: row 0 spans most of the width.
	const row0 = plain(hop[0]);
	assert.ok(row0.includes("████████████████"), "the top bar is wide");
	// Two stems: rows below have two separated groups of blocks.
	const row1 = plain(hop[1]).replace(/\s+$/, "");
	const groups = (row1.match(/█+/g) ?? []).length;
	assert.equal(groups, 2, "exactly two stems below the bar");
});

test("eyes are dark pixels inside the stems on the standing frame, and blink away on frame 2", () => {
	const pet = piPet(0, 0);
	const all = pet.join("\n");
	assert.ok(all.includes("\x1b[38;2;43;29;22m"), "the eye color #2b1d16 appears");
	const blinked = piPet(0, 2).join("\n");
	assert.ok(!blinked.includes("\x1b[38;2;43;29;22m"), "no eye color while blinking");
});

test("the body is drawn in the requested hue", () => {
	for (const [hue, h] of HUES.entries()) {
		const want = `\x1b[38;2;${h.color[0]};${h.color[1]};${h.color[2]}m`;
		assert.ok(piPet(hue, 0).join("\n").includes(want), `${h.name} body color appears`);
	}
});

test("out-of-range hues and frames wrap around, negative included", () => {
	assert.deepEqual(piPet(8, 0), piPet(0, 0));
	assert.deepEqual(piPet(-1, 0), piPet(7, 0));
	assert.deepEqual(piPet(0, 4), piPet(0, 0));
	assert.deepEqual(piPet(0, -1), piPet(0, 3));
});

test("frame 1 hops: the body shifts up one row", () => {
	const stand = piPet(0, 0);
	const hop = piPet(0, 1);
	assert.equal(plain(stand[0]).trim(), "", "the grid leaves the top row empty so the pet can hop into it");
	// Every hop row's content appears one row lower while standing.
	for (let y = 0; y < PET_ROWS - 1; y++) assert.equal(plain(hop[y]), plain(stand[y + 1]), `row ${y} matches stand row ${y + 1}`);
	assert.ok(plain(hop[0]).includes("█"), "the bar reaches the top row mid-hop");
});

test("frame 3 kicks: the feet reach wider than on a standing frame", () => {
	const stand = bodyCells(piPet(0, 0)).filter((c) => c.y === PET_ROWS - 1);
	const kick = bodyCells(piPet(0, 3)).filter((c) => c.y === PET_ROWS - 1);
	const span = (cs: { x: number }[]) => Math.max(...cs.map((c) => c.x)) - Math.min(...cs.map((c) => c.x));
	assert.ok(span(kick) > span(stand), "the kick frame's feet span is wider");
});

test("a standing pet and its hop are exactly one row apart everywhere", () => {
	// Compare each frame's cell set shifted by its dy: they must be identical.
	const shift = (lines: string[], dy: number) =>
		bodyCells(lines)
			.map((c) => `${c.x},${c.y + dy}`)
			.sort()
			.join(";");
	assert.equal(shift(piPet(0, 1), 1), shift(piPet(0, 0), 0), "hop cells land on stand cells when shifted back");
});

test("same hue and frame reuse the same cached lines", () => {
	assert.equal(piPet(2, 1), piPet(2, 1));
	// Different hues give different strings.
	assert.notEqual(piPet(0, 0), piPet(3, 0));
});

test("nextFrame maps time to the 4 frames at 600 ms each", () => {
	assert.equal(nextFrame(0), 0);
	assert.equal(nextFrame(599), 0);
	assert.equal(nextFrame(600), 1);
	assert.equal(nextFrame(1800), 3);
	assert.equal(nextFrame(2400), 0);
});

test("pickHue hands out the next hue no running helper wears, in order", () => {
	// Nobody running: take the next in order.
	assert.equal(pickHue(0, []), 0);
	assert.equal(pickHue(3, []), 3);
	// The next one is taken: skip it.
	assert.equal(pickHue(0, [0]), 1);
	assert.equal(pickHue(0, [0, 1]), 2);
	// Wrap-around skips taken hues too.
	assert.equal(pickHue(7, [7, 0]), 1);
	// All 8 taken: fall back to the next in order.
	assert.equal(pickHue(2, [0, 1, 2, 3, 4, 5, 6, 7]), 2);
	// Negative and large hues normalize.
	assert.equal(pickHue(9, []), 1);
	assert.equal(pickHue(-1, [7]), 0);
});

test("8 helpers can hold 8 distinct hues while running", () => {
	let next = 0;
	const running: number[] = [];
	const taken: number[] = [];
	for (let i = 0; i < 8; i++) {
		const hue = pickHue(next, running);
		assert.ok(!running.includes(hue), `helper ${i} got a fresh hue`);
		taken.push(hue);
		next = hue + 1;
	}
	assert.equal(new Set(taken).size, 8);
});
