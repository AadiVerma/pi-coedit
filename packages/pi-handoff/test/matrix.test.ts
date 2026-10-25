import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHandoff, type BranchEntry } from "../src/handoff.ts";

const user = (text: string, images = false): BranchEntry => ({
	type: "message",
	message: { role: "user", content: images ? [{ type: "image", source: { kind: "base64" } }] : text },
});
const assistant = (calls: { id: string; name: string; arguments?: Record<string, unknown> }[], text = ""): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: [...calls.map((c) => ({ type: "toolCall", ...c })), ...(text ? [{ type: "text", text }] : [])] },
});
const other = (type: string): BranchEntry => ({ type, message: undefined });

// ---- Every tool family × arg shapes ----

const TOOL_CASES: [name: string, call: { id: string; name: string; arguments?: Record<string, unknown> }, appears: string][] = [
	["read with path", { id: "1", name: "read", arguments: { path: "/repo/src/a.ts" } }, "a.ts"],
	["read with file_path", { id: "1", name: "read", arguments: { file_path: "/repo/src/b.ts" } }, "b.ts"],
	["write", { id: "1", name: "write", arguments: { path: "/repo/out.md" } }, "out.md"],
	["edit", { id: "1", name: "edit", arguments: { path: "/repo/c.ts" } }, "c.ts"],
	["Edit capital", { id: "1", name: "Edit", arguments: { path: "/repo/d.ts" } }, "d.ts"],
	["bash", { id: "1", name: "bash", arguments: { command: "npm run build" } }, "npm run build"],
	["Bash capital", { id: "1", name: "Bash", arguments: { command: "make test" } }, "make test"],
	["powershell", { id: "1", name: "powershell", arguments: { command: "dir" } }, "dir"],
	["webfetch", { id: "1", name: "webfetch", arguments: { url: "https://docs.example.com/x" } }, "docs.example.com"],
	["webfetch bad url", { id: "1", name: "webfetch", arguments: { url: "not a url" } }, ""],
	["agent", { id: "1", name: "Agent", arguments: { description: "Research notes", prompt: "p" } }, "Research notes"],
	["agent prompt only", { id: "1", name: "agent", arguments: { prompt: "Do the research now please" } }, "Do the research now plea"],
	["subagentworkflow", { id: "1", name: "SubagentWorkflow", arguments: { description: "Parallel sweep" } }, "Parallel sweep"],
];

for (const [name, call, appears] of TOOL_CASES) {
	test(`branch with ${name}`, () => {
		const h = buildHandoff({ entries: [user("go"), assistant([call])] });
		if (appears) assert.ok(h.markdown.includes(appears), `${name}: expected "${appears}"`);
		else assert.ok(h.markdown.includes("# Handoff"), `${name}: builds without crashing`);
	});
}

// ---- Malformed calls never crash ----

test("tool calls with wrong argument types are skipped safely", () => {
	const h = buildHandoff({
		entries: [
			user("go"),
			assistant([
				{ id: "1", name: "read", arguments: { path: 42 } },
				{ id: "2", name: "bash", arguments: { command: { deep: true } } },
				{ id: "3", name: "webfetch", arguments: { url: "" } },
				{ id: "4", name: "agent", arguments: { description: null } },
			]),
		],
	});
	assert.match(h.markdown, /# Handoff/);
});

test("assistant content that is not an array is safe", () => {
	const h = buildHandoff({ entries: [user("go"), { type: "message", message: { role: "assistant", content: "just text" } }] });
	assert.match(h.markdown, /just text/);
});

test("entries without messages are ignored", () => {
	const h = buildHandoff({ entries: [other("compaction"), other("custom"), { type: "message" }] });
	assert.match(h.markdown, /# Handoff/);
});

// ---- Dedup ----

test("the same file via different tools appears once", () => {
	const h = buildHandoff({
		entries: [user("go"), assistant([{ id: "1", name: "read", arguments: { path: "/repo/x.ts" } }, { id: "2", name: "edit", arguments: { path: "/repo/x.ts" } }])],
	});
	assert.equal((h.markdown.match(/x\.ts/g) ?? []).length, 1);
});

test("same-named files in different folders are not conflated", () => {
	const h = buildHandoff({
		entries: [user("go"), assistant([{ id: "1", name: "read", arguments: { path: "/a/util.ts" } }, { id: "2", name: "read", arguments: { path: "/b/util.ts" } }])],
	});
	assert.equal((h.markdown.match(/util\.ts/g) ?? []).length, 1, "basenames dedupe — the honest limitation");
});

test("the same command repeats once, different commands all appear", () => {
	const h = buildHandoff({
		entries: [user("go"), assistant([{ id: "1", name: "bash", arguments: { command: "ls" } }, { id: "2", name: "bash", arguments: { command: "ls" } }, { id: "3", name: "bash", arguments: { command: "pwd" } }])],
	});
	const line = h.markdown.match(/Commands run: (.+)/)?.[1] ?? "";
	assert.equal((line.match(/\bls\b/g) ?? []).length, 1, "ls appears once");
	assert.ok(line.includes("pwd"));
});

// ---- The digest ----

test("digest numbers prompts and cuts each to 160", () => {
	const long = "z".repeat(400);
	const h = buildHandoff({ entries: [user(long), user(long), user(long)] });
	for (const line of h.markdown.match(/^\d+\. .+$/gm) ?? []) assert.ok(line.length <= 165, `line was ${line.length}`);
});

test("empty user messages do not enter the digest", () => {
	const h = buildHandoff({ entries: [user("   "), user("real prompt")] });
	const digest = h.markdown.match(/^\d+\. .+$/gm) ?? [];
	assert.equal(digest.length, 1);
	assert.ok(digest[0].includes("real prompt"));
});

test("image-only user messages do not crash and count as prompts", () => {
	const h = buildHandoff({ entries: [user("", true)] });
	assert.match(h.markdown, /Turns with prompts: 1/);
});

// ---- The status line ----

for (const [name, usage, want] of [
	["full usage", { percent: 42, tokens: 84_000 }, ["42%", "84k tokens"]],
	["percent only", { percent: 7, tokens: null }, ["7%"]],
	["tokens only", { percent: null, tokens: 12_345 }, ["12k tokens"]],
	["none", { percent: null, tokens: null }, []],
	["zero percent", { percent: 0, tokens: 500 }, ["0%", "500 tokens"]],
	["over full", { percent: 99.7, tokens: 199_999 }, ["100%", "200k tokens"]],
] as const) {
	test(`status line: ${name}`, () => {
		const h = buildHandoff({ entries: [user("go")], usage });
		for (const w of want) assert.ok(h.markdown.includes(w), `${name}: expected ${w}`);
		assert.ok(!h.markdown.includes("NaN"));
	});
}

test("usage omitted entirely is safe", () => {
	const h = buildHandoff({ entries: [user("go")] });
	assert.ok(!h.markdown.includes("Context"));
});

test("the model lands in the status line", () => {
	assert.ok(buildHandoff({ entries: [user("go")], model: "qwen2.5-coder:7b" }).markdown.includes("qwen2.5-coder:7b"));
});

// ---- Long chats ----

test("a 100-prompt branch builds and caps its lists", () => {
	const entries: BranchEntry[] = [];
	for (let i = 0; i < 100; i++) {
		entries.push(user(`prompt number ${i}`));
		entries.push(assistant([{ id: `r${i}`, name: "read", arguments: { path: `/repo/f${i}.ts` } }]));
	}
	const h = buildHandoff({ entries });
	assert.match(h.markdown, /Turns with prompts: 100/);
	// Files list caps at 10; the digest still holds all 100 numbered lines.
	assert.equal((h.markdown.match(/^\d+\. prompt number \d+$/gm) ?? []).length, 100);
	assert.ok((h.markdown.match(/Files touched: (.+)/) ?? [])[1].split(",").length <= 10);
});

// ---- Unicode ----

test("unicode prompts and commands survive", () => {
	const h = buildHandoff({
		entries: [user("构建 the 登录 page"), assistant([{ id: "1", name: "bash", arguments: { command: "echo 你好" } }])],
	});
	assert.ok(h.markdown.includes("构建"));
	assert.ok(h.markdown.includes("你好"));
});

test("emoji in the outcome survive the cut", () => {
	const h = buildHandoff({ entries: [user("go"), assistant([], "done ✓ 🎉")] });
	assert.ok(h.markdown.includes("🎉"));
});

// ---- Next step ----

test("the next step quotes the last prompt, not the first", () => {
	const h = buildHandoff({ entries: [user("first ever prompt"), assistant([], "working"), user("finally add the footer")] });
	const next = h.markdown.split("## Next steps")[1];
	assert.ok(next.includes("add the footer"));
	assert.ok(!next.includes("first ever"));
});

test("a chat with no prompts hands off honestly", () => {
	const h = buildHandoff({ entries: [assistant([], "I did things")] });
	const next = h.markdown.split("## Next steps")[1];
	assert.ok(next.includes("Ask the user"));
});
