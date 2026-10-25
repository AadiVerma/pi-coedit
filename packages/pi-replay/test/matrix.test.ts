import { test } from "node:test";
import assert from "node:assert/strict";
import { collectEdits, type BranchEntry } from "../src/edits.ts";

const call = (id: string, name: string, args: Record<string, unknown>): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const result = (id: string, toolName: string, details?: unknown, isError = false, timestamp?: number): BranchEntry => ({
	type: "message",
	message: { role: "toolResult", toolCallId: id, toolName, details, isError, timestamp },
});

// ---- Diff shapes: everything a diff can look like ----

const DIFFS: [name: string, diff: string, wantPath: string, mustContain: string][] = [
	["pi style", "-1 old line\n+1 new line", "auth.ts", "-1 old line"],
	["unified with headers", "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b", "x.ts", "-a"],
	["multi hunk", "@@ -1,2 +1,2 @@\n-a\n+b\n@@ -9,3 +9,3 @@\n-c\n+d", "main.ts", "-c"],
	["context lines", " context\n-removed\n+added\n context2", "a.ts", " context"],
	["only adds", "+fresh line\n+another", "b.ts", "+fresh line"],
	["only removes", "-gone\n-also gone", "c.ts", "-gone"],
	["empty lines in diff", "-a\n\n+b", "d.ts", "-a"],
	["trailing newline diff", "-a\n+b\n", "e.ts", "+b"],
	["unicode diff", "-旧\n+新", "g.ts", "+新"],
	["crlf diff", "-a\r\n+b\r\n", "h.ts", "+b"],
	["huge single line", `+${"x".repeat(2000)}`, "i.ts", "xxxx"],
	["diff that is only a header", "--- a/x\n+++ b/x", "x", "--- a/x"],
];

for (const [name, diff, wantPath, mustContain] of DIFFS) {
	test(`diff shape: ${name}`, () => {
		const edits = collectEdits([call("e", "edit", { path: `/repo/${wantPath}` }), result("e", "edit", { diff })]);
		assert.equal(edits.length, 1, name);
		assert.equal(edits[0].path, wantPath, name);
		assert.ok(edits[0].diff.includes(mustContain), name);
	});
}

// ---- Which tools replay ----

test("edit and write replay; read, bash, grep never do", () => {
	const edits = collectEdits([
		call("1", "edit", { path: "/r/a.ts" }),
		result("1", "edit", { diff: "-a\n+a" }),
		call("2", "write", { path: "/r/b.md" }),
		result("2", "write", { diff: "+b" }),
		call("3", "read", { path: "/r/c.ts" }),
		result("3", "read", { diff: "-c\n+c" }),
		call("4", "bash", { command: "x" }),
		result("4", "bash", { diff: "output" }),
		call("5", "grep", { pattern: "x" }),
		result("5", "grep", { diff: "match" }),
	]);
	assert.deepEqual(edits.map((e) => e.path), ["a.ts", "b.md"]);
});

test("Edit and Write with capitals replay too", () => {
	const edits = collectEdits([
		call("1", "Edit", { path: "/r/a.ts" }),
		result("1", "Edit", { diff: "-a" }),
		call("2", "Write", { path: "/r/b.md" }),
		result("2", "Write", { diff: "+b" }),
	]);
	assert.equal(edits.length, 2);
});

// ---- Skipping rules ----

for (const [name, details] of [
	["no details", undefined],
	["details without diff", { patch: "x" }],
	["diff empty string", { diff: "" }],
	["diff whitespace only", { diff: "   " }],
	["diff blank lines only", { diff: " \n \n" }],
	["diff wrong type", { diff: 42 }],
] as const) {
	test(`skips result with ${name}`, () => {
		const edits = collectEdits([call("e", "edit", { path: "/r/a.ts" }), result("e", "edit", details)]);
		assert.deepEqual(edits, []);
	});
}

test("an errored edit never replays, even with a diff", () => {
	const edits = collectEdits([call("e", "edit", { path: "/r/a.ts" }), result("e", "edit", { diff: "-a\n+a" }, true)]);
	assert.deepEqual(edits, []);
});

// ---- Ordering ----

test("edits follow result order, not call order", () => {
	const edits = collectEdits([
		call("1", "edit", { path: "/r/first.ts" }),
		call("2", "edit", { path: "/r/second.ts" }),
		result("2", "edit", { diff: "+2" }),
		result("1", "edit", { diff: "+1" }),
	]);
	assert.deepEqual(edits.map((e) => e.path), ["second.ts", "first.ts"]);
});

test("interleaved with non-edit results, order still holds", () => {
	const edits = collectEdits([
		call("1", "edit", { path: "/r/a.ts" }),
		result("1", "edit", { diff: "+a" }),
		call("2", "bash", { command: "ls" }),
		result("2", "bash"),
		call("3", "edit", { path: "/r/b.ts" }),
		result("3", "edit", { diff: "+b" }),
	]);
	assert.deepEqual(edits.map((e) => e.path), ["a.ts", "b.ts"]);
});

test("timestamps ride along when present", () => {
	const edits = collectEdits([
		call("1", "edit", { path: "/r/a.ts" }),
		result("1", "edit", { diff: "+a" }, false, 123_456),
	]);
	assert.equal(edits[0].at, 123_456);
});

// ---- Path fallbacks ----

test("a result without its call falls back to the diff header path", () => {
	const edits = collectEdits([result("e", "edit", { diff: "--- a/src/fallback.ts\n+++ b/src/fallback.ts\n-x\n+y" })]);
	assert.equal(edits[0].path, "src/fallback.ts");
});

test("a result with neither call nor header path is dropped safely", () => {
	const edits = collectEdits([result("e", "edit", { diff: "-x\n+y" })]);
	assert.deepEqual(edits, []);
});

test("paths with unicode and spaces basename correctly", () => {
	const edits = collectEdits([call("e", "edit", { path: "/repo/我的 文件.ts" }), result("e", "edit", { diff: "+x" })]);
	assert.equal(edits[0].path, "我的 文件.ts");
});

// ---- Stress ----

test("200 edits collect in order", () => {
	const entries: BranchEntry[] = [];
	for (let i = 0; i < 200; i++) {
		entries.push(call(`c${i}`, "edit", { path: `/r/f${i}.ts` }));
		entries.push(result(`c${i}`, "edit", { diff: `+${i}` }));
	}
	const edits = collectEdits(entries);
	assert.equal(edits.length, 200);
	assert.equal(edits[0].path, "f0.ts");
	assert.equal(edits[199].path, "f199.ts");
});

test("malformed content arrays never crash", () => {
	const inv = collectEdits([
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } },
		{ type: "message", message: { role: "assistant", content: "text" } },
		{ type: "message", message: { role: "toolResult" } },
	]);
	assert.deepEqual(inv, []);
});
