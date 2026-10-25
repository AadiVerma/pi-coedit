import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createReflect } from "../src/index.ts";

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
	cwd: "/repo",
	ui: {
		confirmTitle: undefined as string | undefined,
		inputTitle: undefined as string | undefined,
		inputPrefill: undefined as string | undefined,
		selectTitle: undefined as string | undefined,
		confirmAnswer: true,
		ruleText: undefined as string | undefined,
		notifications: [] as string[],
		async confirm(title: string, message: string) {
			this.confirmTitle = title;
			return this.confirmAnswer;
		},
		async input(title: string, prefill?: string) {
			this.inputTitle = title;
			this.inputPrefill = prefill;
			return this.ruleText === undefined ? prefill : this.ruleText;
		},
		async select(title: string, options: string[]) {
			this.selectTitle = title;
			return options[0];
		},
		notify(message: string) {
			this.notifications.push(message);
		},
	},
	...overrides,
});

const boot = () => {
	const pi = new FakePi();
	const ext = createReflect(pi as unknown as ExtensionAPI);
	return { pi, ext };
};

test("the extension registers /reflect and no tools", () => {
	const { pi } = boot();
	assert.deepEqual(pi.commands.map((c) => c.name), ["reflect"]);
});

test("a correction after a settled run offers to save a rule", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	const cwd = mkdtempSync(join(tmpdir(), "reflect-"));
	ctx.cwd = cwd;
	await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	const rule = "no, always run tests before committing";
	await pi.fire("input", { type: "input", text: rule, source: "interactive" }, ctx);
	assert.match(ctx.ui.confirmTitle ?? "", /rule/i, "the offer is made");
	const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");
	assert.match(body, /Always run tests before committing\./);
});

test("the rule input is prefilled with the suggested rule", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	ctx.cwd = mkdtempSync(join(tmpdir(), "reflect-"));
	await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	await pi.fire("input", { type: "input", text: "actually use bun for tests", source: "interactive" }, ctx);
	assert.match(ctx.ui.inputPrefill ?? "", /Use bun for tests\./);
});

test("a plain prompt never triggers the offer", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	ctx.cwd = mkdtempSync(join(tmpdir(), "reflect-"));
	await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	await pi.fire("input", { type: "input", text: "now also add a footer", source: "interactive" }, ctx);
	assert.equal(ctx.ui.confirmTitle, undefined);
});

test("the offer is made only once per settled run", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	ctx.cwd = mkdtempSync(join(tmpdir(), "reflect-"));
	ctx.ui.confirmAnswer = false; // decline every offer
	let offers = 0;
	const originalConfirm = ctx.ui.confirm.bind(ctx.ui);
	ctx.ui.confirm = async (title: string, message: string) => {
		offers += 1;
		return originalConfirm(title, message);
	};
	await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	await pi.fire("input", { type: "input", text: "no, use pnpm", source: "interactive" }, ctx);
	await pi.fire("input", { type: "input", text: "no, seriously use pnpm", source: "interactive" }, ctx);
	assert.equal(offers, 1, "the first correction spends the offer");
});

test("answering no to the offer writes nothing", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	const cwd = mkdtempSync(join(tmpdir(), "reflect-"));
	ctx.cwd = cwd;
	ctx.ui.confirmAnswer = false;
	await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	await pi.fire("input", { type: "input", text: "no, use pnpm", source: "interactive" }, ctx);
	assert.throws(() => readFileSync(join(cwd, "AGENTS.md"), "utf8"), "no file written");
});

test("an aborted run does not arm the offer", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	ctx.cwd = mkdtempSync(join(tmpdir(), "reflect-"));
	await pi.fire("agent_settled", { type: "agent_settled", aborted: true }, ctx);
	await pi.fire("input", { type: "input", text: "no, use pnpm", source: "interactive" }, ctx);
	assert.equal(ctx.ui.confirmTitle, undefined);
});

test("in print mode corrections flow untouched", async () => {
	const { pi } = boot();
	const ctx = fakeCtx({ mode: "print" });
	ctx.cwd = mkdtempSync(join(tmpdir(), "reflect-"));
	await pi.fire("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	const r = await pi.fire("input", { type: "input", text: "no, use pnpm", source: "interactive" }, ctx);
	assert.equal(r, undefined);
	assert.equal(ctx.ui.confirmTitle, undefined);
});

test("/reflect saves a rule on demand, without a correction", async () => {
	const { pi } = boot();
	const ctx = fakeCtx();
	const cwd = mkdtempSync(join(tmpdir(), "reflect-"));
	ctx.cwd = cwd;
	ctx.ui.ruleText = "Keep functions under 50 lines.";
	await pi.commands[0].def.handler("", ctx);
	const body = readFileSync(join(cwd, "AGENTS.md"), "utf8");
	assert.match(body, /- Keep functions under 50 lines\./);
});
