import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBrainDump } from "../src/index.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

class FakePi {
	handlers = new Map<string, Handler[]>();
	commands: { name: string; def: any }[] = [];
	on(name: string, handler: Handler) {
		(this.handlers.get(name) ?? this.handlers.set(name, []).get(name)!).push(handler);
		return () => {};
	}
	registerCommand(name: string, def: any) {
		this.commands.push({ name, def });
	}
	async fire(name: string, event: any, ctx: any): Promise<any> {
		let result: any;
		for (const h of this.handlers.get(name) ?? []) result = (await h(event, ctx)) ?? result;
		return result;
	}
}

const fakeCtx = (overrides: Record<string, unknown> = {}) => ({
	hasUI: true,
	mode: "tui",
	editor: { text: "" as string },
	ui: {
		answers: [] as (string | undefined)[],
		escapes: 0,
		notifications: [] as string[],
		async input(title: string, _placeholder?: string) {
			// Scripted answers first; once they run out, remaining dialogs "escape".
			if (this.answers.length) return this.answers.shift();
			if (this.escapes > 0) {
				this.escapes -= 1;
				return undefined;
			}
			return undefined;
		},
		setEditorText(text: string) {
			this.editorText = text;
		},
		editorText: "",
		notify(message: string) {
			this.notifications.push(message);
		},
	},
	...overrides,
});

const LONG = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");

const boot = () => {
	const pi = new FakePi();
	const bd = createBrainDump(pi as unknown as ExtensionAPI);
	return { pi, bd };
};

// ---- Registration ----

test("the extension registers the /brain-dump toggle and no tools", () => {
	const { pi } = boot();
	assert.deepEqual(pi.commands.map((c) => c.name), ["brain-dump"]);
});

test("it starts enabled", () => {
	const { bd } = boot();
	assert.equal(bd.enabled, true);
});

// ---- The gate ----

test("a long loose prompt is intercepted: the send is gated and the editor gets the brief", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	// Questions come in brief order: scope, why, guardrails (done was cut at three).
	ctx.ui.answers = ["src/auth only", "release pressure", "no new deps"];
	const r = await pi.fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
	assert.equal(r.action, "handled", "the original send is stopped");
	assert.match(ctx.ui.editorText, /\n\nScope: src\/auth only/);
	assert.match(ctx.ui.editorText, /## The why\nrelease pressure/);
	assert.match(ctx.ui.editorText, /## Guardrails\nno new deps/);
	assert.match(ctx.ui.editorText, /## Done means\nNot specified/);
});

test("short prompts pass through untouched", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	const r = await pi.fire("input", { type: "input", text: "fix the bug", source: "interactive" }, ctx);
	assert.equal(r, undefined, "no transform, no gate: pi sends it normally");
});

test("commands pass through untouched", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	const r = await pi.fire("input", { type: "input", text: `/model ${LONG}`, source: "interactive" }, ctx);
	assert.equal(r, undefined);
});

test("an already-structured prompt passes through (no double rewriting)", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	const r = await pi.fire("input", { type: "input", text: `## The job\n${LONG}`, source: "interactive" }, ctx);
	assert.equal(r, undefined);
});

test("only interactive prompts are caught (extension sources flow on)", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	const r = await pi.fire("input", { type: "input", text: LONG, source: "extension" }, ctx);
	assert.equal(r, undefined);
});

test("fewer questions when the prompt already answers some", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	ctx.ui.answers = ["a green test run"];
	const text = `${LONG} in src/main.ts because the release depends on it, but don't break the api`;
	// scope, why and guardrails signals are all present: only the done question is asked,
	// and its answer lands in Done means — not in whatever position it was asked.
	const r = await pi.fire("input", { type: "input", text, source: "interactive" }, ctx);
	assert.equal(r.action, "handled");
	assert.match(ctx.ui.editorText, /## Done means\na green test run/);
	assert.match(ctx.ui.editorText, /## The why\nNot specified/, "the why was never asked: it stays fallback");
});

test("no questions needed: the brief is built straight from the prompt", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	const text = `${LONG} in src/auth.ts so that login works, but don't break sessions`;
	const r = await pi.fire("input", { type: "input", text, source: "interactive" }, ctx);
	assert.equal(r.action, "handled");
	assert.match(ctx.ui.editorText, /## The job/);
});

// ---- Escape semantics ----

test("escaping the first question cancels the interception: the original prompt sends", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	ctx.ui.escapes = 1;
	const r = await pi.fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
	assert.equal(r, undefined, "no gate: the original text flows");
	assert.equal(ctx.ui.editorText, "", "the editor is left alone");
});

test("escaping a later question skips that section and keeps the rest", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	ctx.ui.answers = ["for the release"];
	ctx.ui.escapes = 2; // questions 2 and 3 escaped
	const r = await pi.fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
	assert.equal(r.action, "handled");
	assert.match(ctx.ui.editorText, /\n\nScope: for the release/);
	assert.match(ctx.ui.editorText, /## The why\nNot specified/);
	assert.match(ctx.ui.editorText, /## Guardrails\nNone given/);
});

// ---- UI-less modes ----

test("in print or rpc mode the prompt flows untouched", async () => {
	const { pi } = boot();
	const ctx = fakeCtx({ hasUI: false, mode: "print" });
	const r = await pi.fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
	assert.equal(r, undefined);
});

// ---- The toggle ----

test("/brain-dump turns it off and back on", async () => {
	const { pi, bd } = boot();
	const ctx = fakeCtx();
	await pi.commands[0].def.handler("", ctx);
	assert.equal(bd.enabled, false);
	assert.match(ctx.ui.notifications[0], /off/i);

	const r = await pi.fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
	assert.equal(r, undefined, "off: long prompts flow untouched");

	await pi.commands[0].def.handler("", ctx);
	assert.equal(bd.enabled, true);
	assert.match(ctx.ui.notifications[1], /on/i);
});

test("a toggled-off extension re-enables only via the command", async () => {
	const { pi, bd } = boot();
	const ctx = fakeCtx();
	await pi.commands[0].def.handler("", ctx);
	await pi.fire("input", { type: "input", text: LONG, source: "interactive" }, ctx);
	assert.equal(bd.enabled, false);
});
