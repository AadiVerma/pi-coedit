import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInventory, type BranchEntry } from "../src/inventory.ts";

const user = (text: string): BranchEntry => ({ type: "message", message: { role: "user", content: text } });
const assistant = (toolCalls: { id: string; name: string; arguments?: Record<string, unknown> }[] = []): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: toolCalls.map((t) => ({ type: "toolCall", ...t })) },
});
const result = (toolName: string, toolCallId: string, details?: unknown, isError = false): BranchEntry => ({
	type: "message",
	message: { role: "toolResult", toolName, toolCallId, details, isError },
});

test("an empty chat inventories to zeros", () => {
	const inv = buildInventory([]);
	assert.equal(inv.prompts, 0);
	assert.equal(inv.toolCalls, 0);
	assert.equal(inv.plan, null);
	assert.deepEqual(inv.files.read, []);
	assert.deepEqual(inv.files.written, []);
});

test("prompts are counted", () => {
	const inv = buildInventory([user("one"), user("two"), user("three")]);
	assert.equal(inv.prompts, 3);
});

test("tool calls are counted and errors with them", () => {
	const inv = buildInventory([
		user("go"),
		assistant([{ id: "1", name: "read", arguments: { path: "/a.md" } }, { id: "2", name: "bash", arguments: { command: "ls" } }]),
		result("read", "1"),
		result("bash", "2", undefined, true),
	]);
	assert.equal(inv.toolCalls, 2);
	assert.equal(inv.errors, 1);
});

test("reads and writes are separated, deduplicated, basename-only", () => {
	const inv = buildInventory([
		user("go"),
		assistant([
			{ id: "1", name: "read", arguments: { path: "/repo/src/auth.ts" } },
			{ id: "2", name: "read", arguments: { path: "/repo/src/auth.ts" } },
			{ id: "3", name: "read", arguments: { path: "/repo/README.md" } },
			{ id: "4", name: "edit", arguments: { path: "/repo/src/auth.ts" } },
			{ id: "5", name: "write", arguments: { path: "/repo/out.md" } },
		]),
	]);
	assert.deepEqual(inv.files.read, ["auth.ts", "README.md"]);
	assert.deepEqual(inv.files.written, ["auth.ts", "out.md"]);
});

test("commands are listed by description or command", () => {
	const inv = buildInventory([
		user("go"),
		assistant([
			{ id: "1", name: "bash", arguments: { command: "npm test", description: "Run the tests" } },
			{ id: "2", name: "bash", arguments: { command: "ls -la" } },
		]),
	]);
	assert.deepEqual(inv.commands, ["Run the tests", "ls -la"]);
});

test("web hosts and subagents are collected", () => {
	const inv = buildInventory([
		user("go"),
		assistant([
			{ id: "1", name: "webfetch", arguments: { url: "https://docs.example.com/x" } },
			{ id: "2", name: "Agent", arguments: { description: "Research notes", prompt: "p" } },
			{ id: "3", name: "webfetch", arguments: { url: "https://docs.example.com/y" } },
		]),
	]);
	assert.deepEqual(inv.web, ["docs.example.com"]);
	assert.deepEqual(inv.subagents, ["Research notes"]);
});

test("skills used are collected", () => {
	const inv = buildInventory([user("go"), assistant([{ id: "1", name: "skill", arguments: { skill: "video-prep" } }])]);
	assert.deepEqual(inv.skills, ["video-prep"]);
});

test("the plan comes from the last plan tool result, with a done count", () => {
	const plan = { title: "Ship it", steps: [{ text: "a", status: "completed" }, { text: "b", status: "in_progress" }, { text: "c", status: "pending" }] };
	const inv = buildInventory([
		user("go"),
		assistant([{ id: "p1", name: "plan", arguments: { steps: [] } }]),
		result("plan", "p1", plan),
	]);
	assert.deepEqual(inv.plan, { title: "Ship it", done: 1, total: 3 });
});

test("an older plan is superseded by the latest one", () => {
	const first = { title: "Old", steps: [{ text: "a", status: "completed" }] };
	const second = { title: "New", steps: [{ text: "a", status: "completed" }, { text: "b", status: "pending" }] };
	const inv = buildInventory([
		assistant([{ id: "p1", name: "plan", arguments: {} }, { id: "p2", name: "plan", arguments: {} }]),
		result("plan", "p1", first),
		result("plan", "p2", second),
	]);
	assert.equal(inv.plan?.title, "New");
});

test("malformed plan details are ignored, not crashed on", () => {
	const inv = buildInventory([
		assistant([{ id: "p1", name: "plan", arguments: {} }]),
		result("plan", "p1", { title: 42, steps: "nope" }),
		result("plan", "p2", undefined),
	]);
	assert.equal(inv.plan, null);
});

test("a tool call with no matching result still counts as a call", () => {
	const inv = buildInventory([user("go"), assistant([{ id: "9", name: "grep", arguments: { pattern: "x" } }])]);
	assert.equal(inv.toolCalls, 1);
});
