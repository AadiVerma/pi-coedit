/**
 * End-to-end tests for the SHIPPED bundle: dist/index.js is loaded against the real
 * host modules (pi-coding-agent, pi-tui resolve from node_modules), so key handling,
 * width truncation and registration all run the code users actually get.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import helperDesk from "../dist/index.js";

type Handler = (event: any, ctx: any) => Promise<any>;

class FakePi {
	handlers = new Map<string, Handler[]>();
	tools: any[] = [];
	commands: { name: string; def: any }[] = [];
	transformer: ((md: string, ctx: any) => string) | undefined;
	custom: any;
	on(name: string, handler: Handler) {
		(this.handlers.get(name) ?? this.handlers.set(name, []).get(name)!).push(handler);
		return () => {};
	}
	registerTool(tool: any) {
		this.tools.push(tool);
	}
	registerCommand(name: string, def: any) {
		this.commands.push({ name, def });
	}
	registerMarkdownTransformer(t: (md: string, ctx: any) => string) {
		this.transformer = t;
	}
	async fire(name: string, event: any, ctx: any): Promise<any> {
		let result: any;
		for (const h of this.handlers.get(name) ?? []) result = (await h(event, ctx)) ?? result;
		return result;
	}
}

/** A UI context whose custom() captures the component factory's product. */
const tuiCtx = (overrides: Record<string, unknown> = {}) => {
	let component: any;
	let disposed = false;
	return {
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => [] as unknown[] },
		ui: {
			editorPrefill: "" as string | undefined,
			closed: false,
			editorText: "",
			notifications: [] as string[],
			widgets: new Map<string, any>(),
			async input(_t: string, prefill?: string) {
				return prefill;
			},
			async confirm() {
				return true;
			},
			async select(_t: string, options: string[]) {
				return options[0];
			},
			async editor(_t: string, prefill?: string) {
				(this as any).editorPrefill = prefill;
				return prefill;
			},
			notify(m: string) {
				this.notifications.push(m);
			},
			setEditorText(t: string) {
				this.editorText = t;
			},
			setWidget(key: string, content: any) {
				if (content === undefined) this.widgets.delete(key);
				else this.widgets.set(key, content);
			},
			async custom(factory: any) {
				component = factory(
					{ requestRender() {} },
					{ fg: (_t: string, s: string) => s },
					{ matches: () => false },
					() => {
						this.closed = true;
					},
				);
				if (component && typeof component.dispose === "function") {
					// Exercise dispose immediately: it must not throw.
					component.dispose?.();
					disposed = true;
				}
			},
		},
		get component() {
			return component;
		},
		get disposed() {
			return disposed;
		},
		...overrides,
	};
};

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
// helper-desk
// ---------------------------------------------------------------------------

test("dist helper-desk: registers plan tool and /helpers, plan flows, pane renders", async () => {
	const pi = new FakePi();
	const desk = (helperDesk as (pi: any) => any)(pi);
	assert.equal(pi.tools[0].name, "plan");
	assert.deepEqual(pi.commands.map((c) => c.name), ["helpers"]);

	const ctx = tuiCtx();
	await pi.fire("session_start", { type: "session_start" }, ctx);
	const r = await pi.tools[0].execute("p1", { title: "Ship", steps: [{ text: "one", status: "in_progress" }] }, undefined, undefined, ctx);
	assert.match(r.content[0].text, /Plan saved: 0 of 1/);
	assert.ok(ctx.ui.widgets.get("helper-desk:plan"), "the bar widget is set");

	await pi.fire("tool_call", { type: "tool_call", toolName: "Agent", input: { description: "Research" }, toolCallId: "a1" }, ctx);
	assert.equal(desk.helpers.running.length, 1);

	// The pane renders through the real component contract.
	await pi.commands[0].def.handler("", ctx);
	const pane = ctx.component;
	const lines = pane.render(90);
	assert.ok(lines.length > 3);
	assert.ok(plain(lines.join("\n")).includes("Research"));
	assert.ok(lines.every((l: string) => plain(l).length <= 90), "real truncateToWidth holds the width");
	pane.handleInput("\x1b"); // real escape sequence
	assert.equal((ctx.ui as any).closed ?? (ctx as any).closed, true);
});

test("dist helper-desk: the bar widget factory renders against the real truncate", async () => {
	const pi = new FakePi();
	(helperDesk as (pi: any) => any)(pi);
	const ctx = tuiCtx();
	await pi.fire("session_start", { type: "session_start" }, ctx);
	await pi.tools[0].execute("p1", { title: "T", steps: [{ text: "a", status: "completed" }] }, undefined, undefined, ctx);
	const factory = ctx.ui.widgets.get("helper-desk:plan");
	assert.equal(typeof factory, "function");
	const bar = factory({ requestRender() {} }, { fg: (_t: string, s: string) => s });
	const lines = bar.render(40);
	assert.ok(lines.length >= 1);
	assert.ok(lines.every((l: string) => plain(l).length <= 40), `bar fits 40 (got ${lines.map((l: string) => plain(l).length)})`);
	assert.ok(plain(lines[0]).includes("100%"));
});

// ---------------------------------------------------------------------------
// brain-dump
// ---------------------------------------------------------------------------

test("dist brain-dump: gates a long prompt and fills the editor with the brief", async () => {
	const mod = await import("../../pi-brain-dump/dist/index.js");
	const pi = new FakePi();
	(mod.default as (pi: any) => void)(pi);
	const ctx = tuiCtx();
	const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
	const r = await pi.fire("input", { type: "input", text: long, source: "interactive" }, ctx);
	assert.equal(r.action, "handled");
	assert.match(ctx.ui.editorText, /## The job/);
	assert.match(ctx.ui.editorText, /## Done means/);
});

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------

test("dist handoff: builds the handoff from a fake branch and offers a new session", async () => {
	const mod = await import("../../pi-handoff/dist/index.js");
	const pi = new FakePi();
	(mod.default as (pi: any) => void)(pi);
	const ctx = tuiCtx({
		sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Build the thing" } }] },
		getContextUsage: () => ({ percent: 42, tokens: 84_000, contextWindow: 200_000 }),
		model: { id: "test-model" },
		newSession: async () => ({ cancelled: false }),
	});
	await pi.commands[0].def.handler("", ctx);
	assert.match(String((ctx.ui as any).editorPrefill), /# Handoff/);
	assert.match(String(ctx.ui.editorPrefill), /42%/);
	assert.match(String(ctx.ui.editorText), /# Handoff/, "the new session's editor holds it");
});

// ---------------------------------------------------------------------------
// reflect
// ---------------------------------------------------------------------------

test("dist reflect: a correction after settle writes the rule to AGENTS.md", async () => {
	const mod = await import("../../pi-reflect/dist/index.js");
	const pi = new FakePi();
	(mod.default as (pi: any) => void)(pi);
	const cwd = mkdtempSync(join(tmpdir(), "reflect-e2e-"));
	const ctx = tuiCtx({ cwd });
	await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	await pi.fire("input", { type: "input", text: "no, always run tests before committing", source: "interactive" }, ctx);
	const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");
	assert.match(body, /- Always run tests before committing\./);
});

// ---------------------------------------------------------------------------
// chat-inventory
// ---------------------------------------------------------------------------

test("dist chat-inventory: the pane renders a fake branch through real components", async () => {
	const mod = await import("../../pi-chat-inventory/dist/index.js");
	const pi = new FakePi();
	(mod.default as (pi: any) => void)(pi);
	const ctx = tuiCtx({
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "go" } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "1", name: "read", arguments: { path: "/r/a.ts" } },
							{ type: "toolCall", id: "2", name: "Agent", arguments: { description: "Research" } },
						],
					},
				},
			],
		},
	});
	await pi.commands[0].def.handler("", ctx);
	const text = plain(ctx.component.render(80).join("\n"));
	assert.ok(text.includes("Chat Inventory"));
	assert.ok(text.includes("a.ts"));
	assert.ok(text.includes("Research"));
	assert.ok(ctx.component.render(80).every((l: string) => plain(l).length <= 80));
});

// ---------------------------------------------------------------------------
// replay — with REAL key sequences
// ---------------------------------------------------------------------------

test("dist replay: steps through edits with real arrow-key sequences", async () => {
	const mod = await import("../../pi-replay/dist/index.js");
	const pi = new FakePi();
	(mod.default as (pi: any) => void)(pi);
	const ctx = tuiCtx({
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit", arguments: { path: "/r/a.ts" } }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "2", name: "edit", arguments: { path: "/r/b.ts" } }] } },
				{ type: "message", message: { role: "toolResult", toolCallId: "1", toolName: "edit", details: { diff: "-a\n+a" } } },
				{ type: "message", message: { role: "toolResult", toolCallId: "2", toolName: "edit", details: { diff: "-b\n+b" } } },
			],
		},
	});
	await pi.commands[0].def.handler("", ctx);
	const pane = ctx.component;
	assert.ok(plain(pane.render(80).join("\n")).includes("a.ts"));
	pane.handleInput("\x1b[C"); // real right-arrow
	assert.ok(plain(pane.render(80).join("\n")).includes("b.ts"));
	pane.handleInput("\x1b[D"); // real left-arrow
	assert.ok(plain(pane.render(80).join("\n")).includes("a.ts"));
	pane.handleInput("\x1b"); // real escape
	assert.equal((ctx.ui as any).closed ?? (ctx as any).closed, true);
});

// ---------------------------------------------------------------------------
// screen-share
// ---------------------------------------------------------------------------

test("dist screen-share: the transformer masks after the toggle, never user text", async () => {
	const mod = await import("../../pi-screen-share/dist/index.js");
	const pi = new FakePi();
	(mod.default as (pi: any) => void)(pi);
	assert.ok(pi.transformer);
	assert.equal(pi.transformer!("mail a@x.com $500", { messageType: "assistant" }), "mail a@x.com $500", "off by default");
	await pi.commands[0].def.handler("", tuiCtx());
	const out = pi.transformer!("mail a@x.com $500", { messageType: "assistant" });
	assert.ok(!out.includes("a@x.com"));
	assert.ok(!out.includes("$500"));
	assert.equal(pi.transformer!("my a@x.com", { messageType: "user" }), "my a@x.com");
});

// ---------------------------------------------------------------------------
// cache-clock
// ---------------------------------------------------------------------------

test("dist cache-clock: response stamps the clock, warm forces the decision, ttl parses", async () => {
	const mod = await import("../../pi-cache-clock/dist/index.js");
	const pi = new FakePi();
	const ext = (mod.default as (pi: any) => any)(pi);
	const ctx = tuiCtx();
	await pi.fire("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	assert.ok(ctx.ui.widgets.get("cache-clock:countdown"), "the countdown is set");

	const factory = ctx.ui.widgets.get("cache-clock:countdown");
	const face = factory({ requestRender() {} }, { fg: (_t: string, s: string) => s });
	const line = plain(face.render(60)[0]);
	assert.ok(/cache/.test(line), `the face shows the countdown: ${line}`);
	assert.ok(face.render(60)[0].length <= 60);

	assert.equal(await pi.fire("cache_warming_decision", { type: "cache_warming_decision" }, ctx), undefined);
	await pi.commands[0].def.handler("warm", tuiCtx());
	assert.deepEqual(await pi.fire("cache_warming_decision", { type: "cache_warming_decision" }, tuiCtx()), { action: "warm" });
	await pi.commands[0].def.handler("1h", tuiCtx());
	assert.equal(ext.ttlMs, 3_600_000);
});
