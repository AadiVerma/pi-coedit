import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHunks, formatHunks } from "../src/diff.ts";
import { splitLines } from "../src/util.ts";

function lines(s: string): string[] {
	return splitLines(s);
}

test("no change -> no hunks", () => {
	assert.deepEqual(computeHunks(lines("a\nb\nc"), lines("a\nb\nc")), []);
});

test("pure insertion shifts later line numbers", () => {
	const hunks = computeHunks(lines("a\nb\nc"), lines("a\nX\nY\nb\nc"));
	assert.deepEqual(hunks, [{ delStart: 1, delCount: 0, insStart: 1, insCount: 2 }]);
});

test("pure deletion", () => {
	const hunks = computeHunks(lines("a\nb\nc\nd"), lines("a\nd"));
	assert.deepEqual(hunks, [{ delStart: 1, delCount: 2, insStart: 1, insCount: 0 }]);
});

test("replacement is one hunk", () => {
	const hunks = computeHunks(lines("a\nb\nc"), lines("a\nX\nc"));
	assert.deepEqual(hunks, [{ delStart: 1, delCount: 1, insStart: 1, insCount: 1 }]);
});

test("multiple separated hunks", () => {
	const hunks = computeHunks(lines("1\n2\n3\n4\n5\n6\n7"), lines("1\nX\n3\n4\n5\nY\n7"));
	assert.deepEqual(hunks, [
		{ delStart: 1, delCount: 1, insStart: 1, insCount: 1 },
		{ delStart: 5, delCount: 1, insStart: 5, insCount: 1 },
	]);
});

test("overlapping edit blocks merge into one hunk", () => {
	const hunks = computeHunks(lines("a\nb\nc\nd\ne"), lines("a\nB1\nB2\nC2\nd\ne"));
	assert.equal(hunks.length, 1);
	assert.deepEqual(hunks[0], { delStart: 1, delCount: 2, insStart: 1, insCount: 3 });
});

test("CRLF vs LF is treated as equal content", () => {
	assert.deepEqual(computeHunks(lines("a\r\nb\r\nc"), lines("a\nb\nc")), []);
});

test("file created from empty", () => {
	const hunks = computeHunks([], lines("a\nb"));
	assert.deepEqual(hunks, [{ delStart: 0, delCount: 0, insStart: 0, insCount: 2 }]);
});

test("file emptied", () => {
	const hunks = computeHunks(lines("a\nb"), []);
	assert.deepEqual(hunks, [{ delStart: 0, delCount: 2, insStart: 0, insCount: 0 }]);
});

test("very different large files fall back to one replace hunk (bounded)", () => {
	const before = Array.from({ length: 6000 }, (_, i) => `old-${i}`);
	const after = Array.from({ length: 6000 }, (_, i) => `new-${i}`);
	const hunks = computeHunks(before, after);
	assert.equal(hunks.length, 1);
	assert.equal(hunks[0].delCount, 6000);
	assert.equal(hunks[0].insCount, 6000);
});

test("formatHunks renders a readable U0 diff and truncates", () => {
	const text = formatHunks(lines("a\nb\nc"), lines("a\nX\nc"), computeHunks(lines("a\nb\nc"), lines("a\nX\nc")));
	assert.match(text, /@@ -2,1 \+2,1 @@/);
	assert.match(text, /^-b$/m);
	assert.match(text, /^\+X$/m);
	const long = formatHunks(Array.from({ length: 1000 }, (_, i) => `${i}`), Array.from({ length: 1000 }, (_, i) => `x${i}`), computeHunks(Array.from({ length: 1000 }, (_, i) => `${i}`), Array.from({ length: 1000 }, (_, i) => `x${i}`)), 10);
	assert.match(long, /truncated/);
});
