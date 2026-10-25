import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createHandoff } from "../src/index.ts";

class FakePi {
	commands: { name: string; def: any }[] = [];
	registerCommand(name: string, def: any) {
		this.commands.push({ name, def });
	}
}

const fakeCtx = (overrides: Record<string, unknown> = {}) => ({
	hasUI: true,
	mode: "tui",
	sessionManager: {
		getBranch: () => [
			{ type: "message", message: { role: "user", content: "Build the login page" } },
			{ type: "message", message: { role: "user", content: "now add a footer" } },
		],
	},
	getContextUsage: () => ({ percent: 81, tokens: 162_000, contextWindow: 200_000 }),
	model: { id: "claude-opus-4-6" },
	ui: {
		editorTitle: "" as string | undefined,
		editorPrefill: "" as string | undefined,
		editorText: "",
		editorInput: "edited handoff" as string | undefined,
		confirmAnswer: true,
		newSessions: 0,
		notifications: [] as string[],
		async editor(title: string, prefill?: string) {
			this.editorTitle = title;
			this.editorPrefill = prefill;
			return this.editorInput;
		},
		async confirm(title: string, message: string) {
			return this.confirmAnswer;
		},
		setEditorText(text: string) {
			this.editorText = text;
		},
		notify(message: string) {
			this.notifications.push(message);
		},
	},
	newSession() {
		this.ui.newSessions += 1;
		return Promise.resolve({ cancelled: false });
	},
	...overrides,
});

const boot = () => {
	const pi = new FakePi();
	const ext = createHandoff(pi as unknown as ExtensionAPI);
	return { pi, ext };
};

test("the extension registers /handoff and no tools", () => {
	const { pi } = boot();
	assert.deepEqual(pi.commands.map((c) => c.name), ["handoff"]);
});

test("/handoff opens the editor with the built handoff markdown", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	await pi.commands[0].def.handler("", ctx);
	assert.match(ctx.ui.editorPrefill as string, /# Handoff/);
	assert.match(ctx.ui.editorPrefill as string, /now add a footer/, "the next step is the last prompt");
	assert.match(ctx.ui.editorPrefill as string, /81%/);
});

test("/handoff passes the model id into the status line", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	await pi.commands[0].def.handler("", ctx);
	assert.match(ctx.ui.editorPrefill as string, /claude-opus-4-6/);
});

test("confirming starts a fresh session and puts the handoff in the new editor", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	await pi.commands[0].def.handler("", ctx);
	assert.equal(ctx.ui.newSessions, 1);
	assert.equal(ctx.ui.editorText, "edited handoff", "the fresh session's editor holds the handoff");
});

test("answering no to the new-session question keeps the current chat", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	ctx.ui.confirmAnswer = false;
	await pi.commands[0].def.handler("", ctx);
	assert.equal(ctx.ui.newSessions, 0);
});

test("cancelling the editor starts no new session", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	ctx.ui.editorInput = undefined;
	await pi.commands[0].def.handler("", ctx);
	assert.equal(ctx.ui.newSessions, 0);
});

test("an empty branch still opens the editor (the skeleton is valid)", async () => {
	const { pi } = boot();
	const ctx = fakeCtx({
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => undefined,
	});
	await pi.commands[0].def.handler("", ctx);
	assert.match(ctx.ui.editorPrefill as string, /# Handoff/);
});

test("in print mode the command says so instead of opening dialogs", async () => {
	const { pi } = boot();
	const ctx = fakeCtx({ mode: "print" });
	await pi.commands[0].def.handler("", ctx);
	assert.match(ctx.ui.notifications[0], /interactive/i);
});
