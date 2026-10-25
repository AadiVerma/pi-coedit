import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHandoff, type BranchEntry } from "../src/handoff.ts";

const user = (text: string): BranchEntry => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string, toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = []): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: toolCalls.map((t) => ({ type: "toolCall", ...t })), text },
});
const result = (toolName: string, details?: unknown, isError = false): BranchEntry => ({
	type: "message",
	message: { role: "toolResult", toolName, details, isError },
});

test("an empty branch still produces a usable handoff skeleton", () => {
	const h = buildHandoff({ entries: [] });
	assert.match(h.markdown, /# Handoff/);
	assert.match(h.markdown, /## Next steps/);
	assert.equal(h.title, "Handoff");
});

test("the goal is the first user prompt", () => {
	const h = buildHandoff({ entries: [user("Build the login page with tests"), user("now add a footer")] });
	assert.match(h.markdown, /Build the login page with tests/);
});

test("the last user prompt becomes the next step", () => {
	const h = buildHandoff({ entries: [user("first task"), user("now add a footer to the page")] });
	assert.match(h.markdown, /add a footer to the page/);
});

test("files touched are collected from edit, write, and read tool calls, deduplicated", () => {
	const h = buildHandoff({
		entries: [
			user("do it"),
			assistant("working", [
				{ id: "1", name: "edit", arguments: { path: "/repo/src/auth.ts" } },
				{ id: "2", name: "write", arguments: { path: "/repo/src/auth.ts" } },
				{ id: "3", name: "read", arguments: { path: "/repo/README.md" } },
				{ id: "4", name: "bash", arguments: { command: "npm test" } },
			]),
		],
	});
	assert.match(h.markdown, /auth\.ts/);
	assert.match(h.markdown, /README\.md/);
	// auth.ts appears once even though it was edited and written.
	const authMentions = (h.markdown.match(/auth\.ts/g) ?? []).length;
	assert.equal(authMentions, 1);
});

test("commands run are listed", () => {
	const h = buildHandoff({
		entries: [user("go"), assistant("", [{ id: "1", name: "bash", arguments: { command: "npm run build", description: "Build" } }])],
	});
	assert.match(h.markdown, /npm run build/, "the raw command, not just its description");
	assert.match(h.markdown, /Build/, "the description rides along");
});

test("subagent launches are listed by description", () => {
	const h = buildHandoff({
		entries: [user("go"), assistant("", [{ id: "1", name: "Agent", arguments: { description: "Research notes", prompt: "x" } }])],
	});
	assert.match(h.markdown, /Research notes/);
});

test("web hosts are collected from webfetch calls", () => {
	const h = buildHandoff({
		entries: [user("go"), assistant("", [{ id: "1", name: "webfetch", arguments: { url: "https://docs.example.com/x" } }])],
	});
	assert.match(h.markdown, /docs\.example\.com/);
});

test("the last assistant text becomes the outcome, cut to a sane length", () => {
	const long = "x".repeat(600);
	const h = buildHandoff({ entries: [user("go"), assistant(long)] });
	const outcome = h.markdown.match(/Last agent message: "([^"]+)"/)?.[1] ?? "";
	assert.ok(outcome.length <= 401, `outcome was ${outcome.length} chars`);
});

test("usage and model show in the status line when given", () => {
	const h = buildHandoff({ entries: [user("go")], usage: { percent: 42, tokens: 84_000 }, model: "claude-opus-4-6" });
	assert.match(h.markdown, /42%/);
	assert.match(h.markdown, /84k tokens/);
	assert.match(h.markdown, /claude-opus-4-6/);
});

test("a usage of unknown percent does not render a percent sign without a number", () => {
	const h = buildHandoff({ entries: [user("go")], usage: { percent: null, tokens: null } });
	assert.ok(!h.markdown.includes("NaN"));
});

test("long user prompts in the digest are cut to 160 characters", () => {
	const long = "y".repeat(400);
	const h = buildHandoff({ entries: [user(long), user(long)] });
	const digestLines = h.markdown.match(/^\d+\. .+$/gm) ?? [];
	for (const line of digestLines) assert.ok(line.length <= 165, `digest line was ${line.length}`);
});

test("tool calls without arguments do not crash the builder", () => {
	const h = buildHandoff({
		entries: [user("go"), assistant("", [{ id: "1", name: "bash", arguments: {} }]), assistant("", [{ id: "2", name: "edit", arguments: {} }])],
	});
	assert.match(h.markdown, /# Handoff/);
});

test("the handoff never includes tool result noise, only the digest of prompts", () => {
	const h = buildHandoff({ entries: [user("go"), result("bash", { output: "huge output" })] });
	assert.ok(!h.markdown.includes("huge output"));
});

test("errors in tool results do not appear as files", () => {
	const h = buildHandoff({
		entries: [user("go"), assistant("", [{ id: "1", name: "read", arguments: { path: "/x/y.ts" } }]), result("read", undefined, true)],
	});
	assert.match(h.markdown, /y\.ts/, "the attempt still counts as touched");
});
