import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createCacheClock, type ClockState } from "../src/index.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

class FakePi {
	handlers = new Map<string, Handler[]>();
	commands: { name: string; def: any }[] = [];
	widgets = new Map<string, unknown>();
	on(name: string, handler: Handler) {
		(this.handlers.get(name) ?? this.handlers.set(name, []).get(name)!).push(handler);
		return () => {};
	}
	registerCommand(name: string, def: any) {
		this.commands.push({ name, def });
	}
}

const fakeCtx = (overrides: Record<string, unknown> = {}) => ({
	hasUI: true,
	mode: "tui",
	ui: {
		notifications: [] as string[],
		notify(message: string) {
			this.notifications.push(message);
		},
		setWidget(key: string, content: unknown) {
			if (content === undefined) this.widgets.delete(key);
			else this.widgets.set(key, content);
		},
		widgets: new Map<string, unknown>(),
	},
	...overrides,
});

const boot = () => {
	const pi = new FakePi();
	const ext = createCacheClock(pi as unknown as ExtensionAPI);
	return { pi, ext };
};

const run = async (pi: FakePi, name: string, event: any, ctx: any) => {
	let result: any;
	for (const h of pi.handlers.get(name) ?? []) result = (await h(event, ctx)) ?? result;
	return result;
};

test("the extension registers /cache-clock and no tools", () => {
	const { pi } = boot();
	assert.deepEqual(pi.commands.map((c) => c.name), ["cache-clock"]);
});

test("a provider response stamps the clock: the widget appears above the editor", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	await run(pi, "after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	assert.ok(ctx.ui.widgets.get("cache-clock:countdown"), "the countdown widget is set");
});

test("the keep-warm override returns warm only while keep-warm is on", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	const off = await run(pi, "cache_warming_decision", { type: "cache_warming_decision" }, ctx);
	assert.equal(off, undefined, "pi's own policy stands when keep-warm is off");

	await pi.commands[0].def.handler("warm", ctx);
	const on = await run(pi, "cache_warming_decision", { type: "cache_warming_decision" }, ctx);
	assert.deepEqual(on, { action: "warm" });
});

test("/cache-clock warm toggles keep-warm off again", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	await pi.commands[0].def.handler("warm", ctx);
	await pi.commands[0].def.handler("warm", ctx);
	const decision = await run(pi, "cache_warming_decision", { type: "cache_warming_decision" }, ctx);
	assert.equal(decision, undefined);
});

test("/cache-clock 1h widens the ttl", async () => {
	const { pi, ext } = boot();
	const ctx = fakeCtx();
	await pi.commands[0].def.handler("1h", ctx);
	assert.equal(ext.ttlMs, 60 * 60_000);
});

test("a garbage ttl argument is refused with a hint", async () => {
	const { pi, ext } = boot();
	const ctx = fakeCtx();
	await pi.commands[0].def.handler("soon", ctx);
	assert.equal(ext.ttlMs, 5 * 60_000, "the default stands");
	assert.match(ctx.ui.notifications[0], /5m|1h/);
});

test("/cache-clock hides the widget and clears it; showing brings it back", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	await run(pi, "after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	await pi.commands[0].def.handler("hide", ctx);
	assert.equal(ctx.ui.widgets.size, 0);
	await pi.commands[0].def.handler("show", ctx);
	assert.ok(ctx.ui.widgets.get("cache-clock:countdown"));
});

test("session shutdown clears the widget and stops the ticker", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	await run(pi, "after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	await run(pi, "session_shutdown", { type: "session_shutdown" }, ctx);
	assert.equal(ctx.ui.widgets.size, 0);
});

test("a UI-less mode never touches widgets", async () => {
	const { pi } = boot();
	const ctx = fakeCtx({ hasUI: false });
	await run(pi, "after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, ctx);
	assert.equal((ctx.ui as any).widgets.size, 0);
});

test("the exposed state tracks visibility and keep-warm", async () => {
	const { pi, ext } = boot();
	const ctx = fakeCtx();
	assert.equal((ext.state as ClockState).visible, true);
	assert.equal((ext.state as ClockState).keepWarm, false);
	await pi.commands[0].def.handler("warm", ctx);
	assert.equal((ext.state as ClockState).keepWarm, true);
	await pi.commands[0].def.handler("hide", ctx);
	assert.equal((ext.state as ClockState).visible, false);
});
