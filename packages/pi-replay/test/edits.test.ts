import { test } from "node:test";
import assert from "node:assert/strict";
import { collectEdits, type BranchEntry } from "../src/edits.ts";

const call = (id: string, name: string, args: Record<string, unknown>): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const result = (id: string, toolName: string, details?: unknown, isError = false): BranchEntry => ({
	type: "message",
	message: { role: "toolResult", toolCallId: id, toolName, details, isError },
});
const DIFF = "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new";

test("an empty chat has no edits to replay", () => {
	assert.deepEqual(collectEdits([]), []);
});

test("edit tool results with diffs are collected with their file path", () => {
		const edits = collectEdits([call("e1", "edit", { path: "/repo/src/auth.ts" }), result("e1", "edit", { diff: DIFF, patch: "" })]);
	assert.equal(edits.length, 1);
	assert.equal(edits[0].path, "auth.ts", "pi's display diff has no header: the call's path names the file");
	assert.match(edits[0].diff, /-old\n\+new/);
});

test("the path comes from the matching tool call, matched by tool call id", () => {
	const edits = collectEdits([
		call("a", "edit", { path: "/repo/first.ts" }),
		call("b", "edit", { path: "/repo/second.ts" }),
		result("b", "edit", { diff: DIFF }),
		result("a", "edit", { diff: DIFF }),
	]);
	// Branch order: b's result lands before a's, and the replay follows result order.
	assert.deepEqual(edits.map((e) => e.path), ["second.ts", "first.ts"]);
});

test("edit results without a diff are skipped", () => {
	const edits = collectEdits([call("e1", "edit", { path: "/x.ts" }), result("e1", "edit", undefined)]);
	assert.deepEqual(edits, []);
});

test("failed edits are not replayed", () => {
	const edits = collectEdits([call("e1", "edit", { path: "/x.ts" }), result("e1", "edit", { diff: DIFF }, true)]);
	assert.deepEqual(edits, []);
});

test("write results with diffs are replayed too", () => {
	const edits = collectEdits([call("w1", "write", { path: "/repo/new.md" }), result("w1", "write", { diff: DIFF })]);
	assert.equal(edits.length, 1);
	assert.equal(edits[0].path, "new.md");
});

test("a path unknown from its call falls back to the diff header", () => {
	const edits = collectEdits([result("e1", "edit", { diff: DIFF })]);
	assert.equal(edits[0].path, "src/auth.ts");
});

test("the same file edited twice appears twice, in replay order", () => {
	const edits = collectEdits([
		call("a", "edit", { path: "/repo/auth.ts" }),
		result("a", "edit", { diff: DIFF }),
		call("b", "edit", { path: "/repo/auth.ts" }),
		result("b", "edit", { diff: DIFF.replace("old", "older") }),
	]);
	assert.equal(edits.length, 2);
	assert.match(edits[1].diff, /older/);
});

test("edit results carry their timestamp when present", () => {
	const edits = collectEdits([call("e1", "edit", { path: "/x.ts" }), result("e1", "edit", { diff: DIFF })].map((e, i) => {
		if (e.message?.role === "toolResult") e.message.timestamp = 1000 + i;
		return e;
	}));
	assert.equal(edits[0].at > 0, true);
});
