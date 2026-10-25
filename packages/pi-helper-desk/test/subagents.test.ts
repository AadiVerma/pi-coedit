import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createHelperDesk } from "../src/index.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

class FakePi {
	handlers = new Map<string, Handler[]>();
	tools: any[] = [];
	commands: { name: string; def: any }[] = [];
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
	async fire(name: string, event: any, ctx: any): Promise<any> {
		let result: any;
		for (const h of this.handlers.get(name) ?? []) result = (await h(event, ctx)) ?? result;
		return result;
	}
}

const ctx = () => ({ hasUI: false, mode: "tui", sessionManager: { getBranch: () => [] } });

const desk = () => {
	const pi = new FakePi();
	return { pi, desk: createHelperDesk(pi as unknown as ExtensionAPI) };
};

const call = (pi: FakePi, toolName: string, input: Record<string, unknown>, toolCallId: string, extra: Record<string, unknown> = {}) =>
	pi.fire("tool_call", { type: "tool_call", toolName, input, toolCallId, ...extra }, ctx());
const done = (pi: FakePi, toolName: string, input: Record<string, unknown>, toolCallId: string, extra: Record<string, unknown> = {}) =>
	pi.fire("tool_result", { type: "tool_result", toolName, input, toolCallId, content: [{ type: "text", text: "ok" }], isError: false, ...extra }, ctx());

// The exact casing @tintinweb/pi-subagents registers, × background modes × errors.
// AGENT/WORKFLOW casing variants cover any future rename.
const AGENT_NAMES = ["Agent", "agent", "AGENT", "SubagentWorkflow", "subagentworkflow"];
const BG: [name: string, input: Record<string, unknown>][] = [
	["background default (no flag)", { description: "Research" }],
	["explicit background", { description: "Research", run_in_background: true }],
	["foreground", { description: "Research", run_in_background: false }],
];
const ERR = [false, true];

for (const toolName of AGENT_NAMES) {
	for (const [bgName, input] of BG) {
		for (const isError of ERR) {
			test(`${toolName} ${bgName}${isError ? " errored" : ""}`, async () => {
				const { pi, desk: d } = desk();
				await call(pi, toolName, input, "a1");
				assert.equal(d.helpers.running.length, 1, "spawned");
				assert.equal(d.helpers.running[0].label, "Subagent: Research", "label from description, any casing");

				await done(pi, toolName, input, "a1", { isError });
				const foreground = input.run_in_background === false;
				if (isError) assert.equal(d.helpers.stopped.length, 1, "an errored spawn stops");
				else if (foreground) assert.equal(d.helpers.finished.length, 1, "foreground finishes with the call");
				else assert.equal(d.helpers.running.length, 1, "background stays running until collected");
			});
		}
	}
}

// Collection semantics.
for (const toolName of ["get_subagent_result", "Get_Subagent_Result", "GET_SUBAGENT_RESULT"]) {
	for (const isError of ERR) {
		test(`${toolName}${isError ? " errored" : ""} finishing waiting helpers`, async () => {
			const { pi, desk: d } = desk();
			await call(pi, "Agent", { description: "A" }, "a1");
			await call(pi, "Agent", { description: "B" }, "a2");
			await done(pi, "Agent", { description: "A" }, "a1");
			await done(pi, "Agent", { description: "B" }, "a2");
			await call(pi, toolName, { id: "a1" }, "g1");
			await done(pi, toolName, { id: "a1" }, "g1", { isError });
			if (isError) assert.equal(d.helpers.running.length, 2, "an errored collection leaves them running");
			else assert.equal(d.helpers.finished.length, 2, "collection finishes both");
		});
	}
}

// Steering a subagent is not a finish.
test("steer_subagent never finishes a helper", async () => {
	const { pi, desk: d } = desk();
	await call(pi, "Agent", { description: "A" }, "a1");
	await done(pi, "Agent", { description: "A" }, "a1");
	await call(pi, "steer_subagent", { id: "a1", message: "focus" }, "s1");
	await done(pi, "steer_subagent", { id: "a1" }, "s1");
	assert.equal(d.helpers.running.length, 1, "still running");
});

// Nested calls (issued by another tool) never spawn helpers.
test("nested Agent calls (parentToolCallId) are invisible to the desk", async () => {
	const { pi, desk: d } = desk();
	await call(pi, "Agent", { description: "inner" }, "p0/1", { parentToolCallId: "p0" });
	await done(pi, "Agent", { description: "inner" }, "p0/1", { parentToolCallId: "p0" });
	assert.equal(d.helpers.all.length, 0);
	assert.equal(d.feed.length, 0, "nested calls do not even reach the feed");
});

// Hue discipline across the full 8-hue cycle with finishes between.
test("eight spawns with finishes between reuse freed hues without collision while running", async () => {
	const { pi, desk: d } = desk();
	const seenRunning: number[] = [];
	for (let i = 0; i < 12; i++) {
		await call(pi, "Agent", { description: `A${i}` }, `a${i}`);
		const running = d.helpers.running;
		const hues = running.map((h: any) => h.hue);
		assert.equal(new Set(hues).size, hues.length, `iteration ${i}: running hues unique`);
		seenRunning.push(...hues);
		// Finish half of them (foreground to finish immediately), others wait for collection.
		if (i % 2 === 0) {
			await call(pi, "get_subagent_result", { id: `a${i}` }, `g${i}`);
			await done(pi, "get_subagent_result", { id: `a${i}` }, `g${i}`);
		}
	}
	assert.ok(seenRunning.length >= 12);
});

// The feed labels for every casing.
test("feed labels use the subagent's description for every casing", async () => {
	const { pi, desk: d } = desk();
	await call(pi, "Agent", { description: "One", prompt: "x" }, "a1");
	await call(pi, "agent", { prompt: "Just a prompt here" }, "a2");
	await call(pi, "AGENT", {}, "a3");
	const labels = d.feed.map((f: any) => f.label);
	assert.equal(labels[0], "Subagent: One");
	assert.equal(labels[1], "Subagent: Just a prompt here");
	assert.equal(labels[2], "Starting a subagent");
});

// Real session shape from the user's capture: plan → Agent (background) → 21s → collect.
test("replay of the real captured session: card runs for 21s then finishes on collect", async () => {
	const { pi, desk: d } = desk();
	await call(pi, "plan", { steps: [{ text: "s", status: "in_progress" }] }, "p1");
	await done(pi, "plan", { steps: [] }, "p1");
	await call(pi, "Agent", { description: "Research project changelogs", prompt: "go" }, "a1");
	await done(pi, "Agent", { description: "Research project changelogs" }, "a1"); // spawn ack
	assert.equal(d.helpers.running[0].label, "Subagent: Research project changelogs");
	await new Promise((r) => setTimeout(r, 25));
	assert.equal(d.helpers.running.length, 1, "still running mid-wait");
	await call(pi, "get_subagent_result", { id: "a1" }, "g1");
	await done(pi, "get_subagent_result", { id: "a1" }, "g1");
	assert.equal(d.helpers.finished.length, 1);
	const h = d.helpers.finished[0];
	const elapsed = (h.endedAt ?? 0) - h.startedAt;
	assert.ok(elapsed >= 20, `elapsed ${elapsed}ms`);
});
