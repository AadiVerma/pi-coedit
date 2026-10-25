import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { InventoryPane } from "../src/pane.ts";
import { buildInventory, type BranchEntry } from "../src/inventory.ts";

const fakeTheme = { fg: (_t: string, s: string) => s } as unknown as Theme;
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const entries: BranchEntry[] = [
	{ type: "message", message: { role: "user", content: "first" } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "1", name: "plan", arguments: {} },
				{ type: "toolCall", id: "2", name: "read", arguments: { path: "/repo/README.md" } },
				{ type: "toolCall", id: "3", name: "edit", arguments: { path: "/repo/src/auth.ts" } },
				{ type: "toolCall", id: "4", name: "bash", arguments: { command: "npm test", description: "Run the tests" } },
				{ type: "toolCall", id: "5", name: "webfetch", arguments: { url: "https://docs.example.com/x" } },
				{ type: "toolCall", id: "6", name: "Agent", arguments: { description: "Research notes" } },
				{ type: "toolCall", id: "7", name: "skill", arguments: { skill: "video-prep" } },
			],
		},
	},
	{ type: "message", message: { role: "toolResult", toolName: "plan", toolCallId: "1", details: { title: "Ship it", steps: [{ status: "completed" }, { status: "pending" }] } } },
];

const pane = (inv = buildInventory(entries), width = 90) =>
	new InventoryPane(inv, fakeTheme).render(width);
const text = (inv?: ReturnType<typeof buildInventory>, width?: number) =>
	(inv ? pane(inv, width) : pane(undefined, width)).map(plain).join("\n");

test("the pane opens with a Chat Inventory header", () => {
	assert.match(text(), /Chat Inventory/);
});

test("counts appear: prompts, tool calls, errors", () => {
	const t = text();
	assert.match(t, /1 prompt/);
	assert.match(t, /7 tool calls/);
});

test("the plan shows its title and progress", () => {
	assert.match(text(), /Ship it · 1\/2 done/);
});

test("files are split into read and written groups", () => {
	const t = text();
	assert.match(t, /README\.md/);
	assert.match(t, /auth\.ts/);
	assert.match(t, /Read \(/);
	assert.match(t, /Written \(/);
});

test("commands, web, subagents and skills each get a section when present", () => {
	const t = text();
	assert.match(t, /Run the tests/);
	assert.match(t, /docs\.example\.com/);
	assert.match(t, /Research notes/);
	assert.match(t, /video-prep/);
});

test("sections with nothing in them are omitted", () => {
	const t = text(buildInventory([{ type: "message", message: { role: "user", content: "hi" } }]));
	assert.ok(!t.includes("Written"));
	assert.ok(!t.includes("Subagents"));
	assert.ok(!t.includes("Skills"));
});

test("an empty chat says so", () => {
	const t = text(buildInventory([]));
	assert.match(t, /No tool calls yet/);
});

test("every line fits the width it was given", () => {
	for (const width of [40, 60, 90, 140]) {
		for (const line of pane(undefined, width)) {
			assert.ok(plain(line).length <= width, `fits ${width}: ${plain(line).length}`);
		}
	}
});

test("render caches by width until invalidate", () => {
	const view = new InventoryPane(buildInventory(entries), fakeTheme);
	const first = view.render(90);
	assert.equal(view.render(90), first);
	view.invalidate();
	assert.notEqual(view.render(90), first);
	assert.deepEqual(view.render(90), first);
});
