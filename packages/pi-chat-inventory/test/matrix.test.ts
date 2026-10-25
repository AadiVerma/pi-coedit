import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInventory, type BranchEntry } from "../src/inventory.ts";

const user = (text: string): BranchEntry => ({ type: "message", message: { role: "user", content: text } });
const calls = (...list: { id: string; name: string; arguments?: Record<string, unknown> }[]): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: list.map((c) => ({ type: "toolCall", ...c })) },
});
const result = (toolName: string, toolCallId: string, details?: unknown, isError = false): BranchEntry => ({
	type: "message",
	message: { role: "toolResult", toolName, toolCallId, details, isError },
});

// ---- Tool × args matrix: every tool lands in its group ----

const GROUPS: [name: string, tool: string, args: Record<string, unknown>, group: string, item: string][] = [
	["read path", "read", { path: "/r/a.ts" }, "read", "a.ts"],
	["read file_path", "read", { file_path: "/r/b.ts" }, "read", "b.ts"],
	["grep with path", "grep", { pattern: "x", path: "/r/src" }, "read", "src"],
	["find no path", "find", { pattern: "y" }, "read", ""],
	["ls path", "ls", { path: "/r/docs" }, "read", "docs"],
	["write", "write", { path: "/r/out.md" }, "written", "out.md"],
	["edit", "edit", { path: "/r/c.ts" }, "written", "c.ts"],
	["Edit capital", "Edit", { path: "/r/d.ts" }, "written", "d.ts"],
	["bash", "bash", { command: "npm test" }, "commands", "npm test"],
	["Bash with description", "Bash", { command: "x", description: "Run the tests" }, "commands", "Run the tests"],
	["powershell", "powershell", { command: "dir" }, "commands", "dir"],
	["webfetch", "webfetch", { url: "https://a.example.com/x" }, "web", "a.example.com"],
	["websearch", "websearch", { query: "pi agent" }, "web", ""],
	["Agent", "Agent", { description: "Research notes" }, "subagents", "Research notes"],
	["agent prompt only", "agent", { prompt: "Do the research" }, "subagents", "Do the research"],
	["SubagentWorkflow", "SubagentWorkflow", { description: "Sweep" }, "subagents", "Sweep"],
	["skill", "skill", { skill: "video-prep" }, "skills", "video-prep"],
	["plan", "plan", {}, "none", ""],
	["unknown tool", "mystery", {}, "none", ""],
];

for (const [name, tool, args, group, item] of GROUPS) {
	test(`${name} lands in ${group}`, () => {
		const inv = buildInventory([user("go"), calls({ id: "1", name: tool, arguments: args })]);
		if (group === "read") {
			if (item) assert.ok(inv.files.read.includes(item), `${tool}: ${item} in read`);
			else assert.deepEqual(inv.files.read, []);
		} else if (group === "written") assert.ok(inv.files.written.includes(item));
		else if (group === "commands") assert.ok(inv.commands.includes(item));
		else if (group === "web") {
			if (item) assert.ok(inv.web.includes(item));
			else assert.deepEqual(inv.web, []);
		} else if (group === "subagents") assert.ok(inv.subagents.includes(item));
		else if (group === "skills") assert.ok(inv.skills.includes(item));
		else {
			assert.deepEqual(inv.files, { read: [], written: [] });
			assert.deepEqual(inv.commands, []);
		}
		assert.equal(inv.toolCalls, 1);
	});
}

// ---- Malformed inputs ----

test("non-string path args are ignored", () => {
	const inv = buildInventory([user("go"), calls({ id: "1", name: "read", arguments: { path: 7 } })]);
	assert.deepEqual(inv.files.read, []);
	assert.equal(inv.toolCalls, 1);
});

test("assistant content that is not tool calls is safe", () => {
	const inv = buildInventory([{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }]);
	assert.equal(inv.toolCalls, 0);
});

test("entries without messages are skipped", () => {
	const inv = buildInventory([{ type: "compaction" }, { type: "message" }]);
	assert.equal(inv.prompts, 0);
});

test("an image-only user message counts as a prompt", () => {
	const inv = buildInventory([{ type: "message", message: { role: "user", content: [{ type: "image" }] } }]);
	assert.equal(inv.prompts, 1);
});

// ---- Errors ----

test("errors count from results, not calls", () => {
	const inv = buildInventory([
		calls({ id: "1", name: "bash", arguments: {} }, { id: "2", name: "read", arguments: {} }),
		result("bash", "1", undefined, true),
		result("read", "2"),
	]);
	assert.equal(inv.toolCalls, 2);
	assert.equal(inv.errors, 1);
});

test("a call without a result still counts once", () => {
	const inv = buildInventory([calls({ id: "9", name: "grep", arguments: {} })]);
	assert.equal(inv.toolCalls, 1);
	assert.equal(inv.errors, 0);
});

// ---- Plan shapes ----

const PLANS: [name: string, details: unknown, want: { title: string; done: number; total: number } | null][] = [
	["normal", { title: "T", steps: [{ status: "completed" }, { status: "pending" }] }, { title: "T", done: 1, total: 2 }],
	["no title", { steps: [{ status: "in_progress" }] }, { title: "Plan", done: 0, total: 1 }],
	["empty title", { title: "", steps: [] }, { title: "Plan", done: 0, total: 0 }],
	["all done", { title: "T", steps: [{ status: "completed" }, { status: "completed" }] }, { title: "T", done: 2, total: 2 }],
	["steps not array", { title: "T", steps: "x" }, null],
	["steps wrong items", { title: "T", steps: [1, "a", null] }, { title: "T", done: 0, total: 0 }],
	["details null", null, null],
	["details undefined", undefined, null],
	["title wrong type", { title: 42, steps: [{ status: "completed" }] }, { title: "Plan", done: 1, total: 1 }],
];

for (const [name, details, want] of PLANS) {
	test(`plan details: ${name}`, () => {
		const inv = buildInventory([calls({ id: "p", name: "plan", arguments: {} }), result("plan", "p", details)]);
		assert.deepEqual(inv.plan, want);
	});
}

test("the latest plan wins regardless of position", () => {
	const inv = buildInventory([
		calls({ id: "p1", name: "plan" }, { id: "p2", name: "plan" }),
		result("plan", "p1", { title: "Old", steps: [{ status: "completed" }] }),
		user("more"),
		result("plan", "p2", { title: "New", steps: [{ status: "pending" }] }),
	]);
	assert.equal(inv.plan?.title, "New");
});

test("a malformed plan after a good one does not erase it", () => {
	const inv = buildInventory([
		result("plan", "p1", { title: "Good", steps: [{ status: "pending" }] }),
		result("plan", "p2", { title: 9, steps: null }),
	]);
	assert.equal(inv.plan?.title, "Good");
});

// ---- Case-insensitive plan tool ----

test("Plan (capital) results are recognized", () => {
	const inv = buildInventory([result("Plan", "p", { title: "T", steps: [{ status: "completed" }] })]);
	assert.equal(inv.plan?.title, "T");
});

// ---- Dedup and caps ----

test("repeat files dedupe within their group", () => {
	const inv = buildInventory([
		calls(
			{ id: "1", name: "read", arguments: { path: "/r/a.ts" } },
			{ id: "2", name: "read", arguments: { path: "/r/a.ts" } },
			{ id: "3", name: "grep", arguments: { path: "/r/a.ts" } },
		),
	]);
	assert.deepEqual(inv.files.read, ["a.ts"]);
});

test("a file can be in both read and written", () => {
	const inv = buildInventory([
		calls({ id: "1", name: "read", arguments: { path: "/r/a.ts" } }, { id: "2", name: "edit", arguments: { path: "/r/a.ts" } }),
	]);
	assert.deepEqual(inv.files.read, ["a.ts"]);
	assert.deepEqual(inv.files.written, ["a.ts"]);
});

test("50 distinct reads all register", () => {
	const list = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: "read", arguments: { path: `/r/f${i}.ts` } }));
	const inv = buildInventory([calls(...list)]);
	assert.equal(inv.files.read.length, 50);
	assert.equal(inv.toolCalls, 50);
});

// ---- Empty branch ----

test("an empty branch inventories to zeros everywhere", () => {
	const inv = buildInventory([]);
	assert.deepEqual(inv, {
		prompts: 0,
		toolCalls: 0,
		errors: 0,
		files: { read: [], written: [] },
		commands: [],
		web: [],
		subagents: [],
		skills: [],
		plan: null,
	});
});
