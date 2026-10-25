import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createHelperDesk } from "../src/index.ts";
import type { PlanDetails } from "../src/types.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

/** A pi stand-in that records registrations and replays events to the handlers. */
class FakePi {
	handlers = new Map<string, Handler[]>();
	tools: any[] = [];
	commands: { name: string; def: any }[] = [];

	on(name: string, handler: Handler) {
		const list = this.handlers.get(name) ?? [];
		list.push(handler);
		this.handlers.set(name, list);
		return () => {};
	}

	registerTool(tool: any) {
		this.tools.push(tool);
	}

	registerCommand(name: string, def: any) {
		this.commands.push({ name, def });
	}

	async fire(name: string, event: any, ctx: any): Promise<any> {
		// Pi composes transform handlers: the last non-undefined return wins.
		let result: any;
		for (const h of this.handlers.get(name) ?? []) result = (await h(event, ctx)) ?? result;
		return result;
	}
}

/** A session context with no UI by default. */
const fakeCtx = (overrides: Record<string, unknown> = {}) => ({
	hasUI: false,
	mode: "tui",
	sessionManager: { getBranch: () => [] as unknown[] },
	ui: {
		notifications: [] as { message: string; type?: string }[],
		widgets: new Map<string, unknown>(),
		notify(message: string, type?: string) {
			this.notifications.push({ message, type });
		},
		setWidget(key: string, content: unknown) {
			if (content === undefined) this.widgets.delete(key);
			else this.widgets.set(key, content);
		},
	},
	...overrides,
});

const boot = () => {
	const pi = new FakePi();
	const desk = createHelperDesk(pi as unknown as ExtensionAPI);
	return { pi, desk };
};

const toolCall = ({ pi }: { pi: FakePi }, tool: string, input: Record<string, unknown> = {}, toolCallId = "t1") =>
	pi.fire("tool_call", { type: "tool_call", toolName: tool, input, toolCallId }, fakeCtx());

const toolResult = (
	{ pi }: { pi: FakePi },
	tool: string,
	input: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
) =>
	pi.fire(
		"tool_result",
		{ type: "tool_result", toolName: tool, input, toolCallId: "t1", content: [{ type: "text", text: "ok" }], isError: false, ...extra },
		fakeCtx(),
	);

/**
 * The content length a tool result ends up with: a handler that returns undefined
 * means "no change", so the original single-item content stands.
 */
const contentLength = (r: { content?: unknown[] } | undefined) => (r === undefined ? 1 : (r.content as unknown[]).length);

// ---- Registration ----

test("the extension registers the plan tool and the /helpers command", () => {
	const { pi } = boot();
	assert.equal(pi.tools.length, 1);
	assert.equal(pi.tools[0].name, "plan");
	assert.deepEqual(pi.commands.map((c) => c.name), ["helpers"]);
});

test("the plan tool carries prompt guidelines that ride with it", () => {
	const { pi } = boot();
	const guidelines = pi.tools[0].promptGuidelines as string[];
	assert.ok(Array.isArray(guidelines) && guidelines.length >= 2);
	assert.ok(guidelines.join(" ").includes("plan tool first"));
	assert.ok(guidelines.join(" ").includes("before your final answer"));
});

// ---- The plan tool ----

test("a valid plan is saved with its count in the answer", async () => {
	const { pi } = boot();
	const r = await pi.tools[0].execute("p1", { title: "Ship it", steps: [{ text: "a", status: "pending" }] }, undefined, undefined, fakeCtx());
	assert.equal(r.content[0].text, "Plan saved: 0 of 1 steps done.");
	assert.equal((r.details as PlanDetails).title, "Ship it");
});

test("bad steps are refused with a reason, not saved", async () => {
	const { pi } = boot();
	const r = await pi.tools[0].execute("p1", { steps: [{ text: "", status: "pending" }] }, undefined, undefined, fakeCtx());
	assert.match(r.content[0].text, /Plan not saved/);
});

test("progressing a plan reports what it saved and stamps done times", async () => {
	const { pi } = boot();
	await pi.tools[0].execute("p1", { title: "T", steps: [{ text: "a", status: "in_progress" }] }, undefined, undefined, fakeCtx());
	const r = await pi.tools[0].execute("p2", { title: "T", steps: [{ text: "a", status: "completed" }] }, undefined, undefined, fakeCtx());
	assert.equal(r.content[0].text, "Plan saved: 1 of 1 steps done.");
	assert.equal((r.details.steps[0].doneAt as string).length > 0, true);
});

// ---- The nudge ----

test("the nudge appends to the content once per run", async () => {
	const { pi } = boot();
	const first = await toolResult({ pi }, "read");
	const second = await toolResult({ pi }, "bash");
	assert.equal((first!.content as unknown[]).length, 2);
	assert.match((first!.content as any[])[1].text, /Helper Desk: no plan yet/);
	assert.equal(contentLength(second), 1, "no second nudge in the same run");
});

test("a new run may nudge again", async () => {
	const { pi } = boot();
	await toolResult({ pi }, "read");
	await pi.fire("before_agent_start", { type: "before_agent_start" }, fakeCtx());
	const next = await toolResult({ pi }, "read");
	assert.equal((next!.content as unknown[]).length, 2);
});

test("the plan tool's own results are never nudged", async () => {
	const { pi } = boot();
	const r = await toolResult({ pi }, "plan");
	assert.equal(contentLength(r), 1);
});

test("errored results are not nudged", async () => {
	const { pi } = boot();
	const r = await toolResult({ pi }, "read", {}, { isError: true });
	assert.equal(contentLength(r), 1);
});

test("nested tool calls (from another tool) are not nudged", async () => {
	const { pi } = boot();
	const r = await toolResult({ pi }, "read", {}, { parentToolCallId: "p0" });
	assert.equal(contentLength(r), 1);
});

test("no nudge while a live plan exists", async () => {
	const { pi, desk } = boot();
	await pi.tools[0].execute("p1", { title: "T", steps: [{ text: "a", status: "in_progress" }] }, undefined, undefined, fakeCtx());
	assert.equal(desk.state.hasLivePlan(), true);
	const r = await toolResult({ pi }, "read");
	assert.equal(contentLength(r), 1);
});

// ---- The feed ----

test("tool calls land in the feed with their kind and label", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "read", { path: "/a/b/research.md" });
	await toolCall({ pi }, "bash", { description: "List the temp folder" }, "t2");
	await toolCall({ pi }, "agent", { description: "Research notes" }, "a1");
	assert.equal(desk.feed.length, 3);
	assert.deepEqual(
		desk.feed.map((f: any) => [f.kind, f.label]),
		[
			["File read", "Reading research.md"],
			["Command", "List the temp folder"],
			["Subagent", "Subagent: Research notes"],
		],
	);
});

test("a tool result marks its feed item done, and an error marks it", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "read", { path: "/a/b/research.md" }, "t1");
	await toolCall({ pi }, "bash", { command: "nope" }, "t2");
	await toolResult({ pi }, "read", { path: "/a/b/research.md" }, { toolCallId: "t1" });
	await toolResult({ pi }, "bash", { command: "nope" }, { toolCallId: "t2", isError: true });
	const [read, bash] = desk.feed;
	assert.equal(read.done, true);
	assert.equal(read.error, undefined);
	assert.equal(bash.done, true);
	assert.equal(bash.error, true);
});

test("the feed is capped at 40 items, oldest dropped", async () => {
	const { pi, desk } = boot();
	for (let i = 0; i < 50; i++) await toolCall({ pi }, `tool${i}`, {}, `c${i}`);
	assert.equal(desk.feed.length, 40);
	assert.equal(desk.feed[0].label, "Using tool10");
	assert.equal(desk.feed[39].label, "Using tool49");
});

// ---- Subagent helpers ----

test("an Agent launch makes a running helper; the background spawn result alone leaves it running", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "agent", { description: "Research notes" }, "a1");
	assert.equal(desk.helpers.all.length, 1);
	assert.equal(desk.helpers.running[0].label, "Subagent: Research notes");

	await toolResult({ pi }, "agent", { description: "Research notes" }, { toolCallId: "a1" });
	assert.equal(desk.helpers.finished.length, 0, "background: the real result comes later");
	assert.equal(desk.helpers.running.length, 1);

	await toolCall({ pi }, "get_subagent_result", {}, "g1");
	await toolResult({ pi }, "get_subagent_result", {}, { toolCallId: "g1" });
	assert.equal(desk.helpers.finished.length, 1);
	assert.equal(desk.helpers.running.length, 0);
});

test("an errored Agent result stops its helper", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "agent", { description: "Boom" }, "a1");
	await toolResult({ pi }, "agent", { description: "Boom" }, { toolCallId: "a1", isError: true });
	assert.equal(desk.helpers.stopped.length, 1);
});

test("SubagentWorkflow launches count as helpers too; ordinary tools never spawn one", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "subagentworkflow", { description: "Parallel research" }, "w1");
	assert.equal(desk.helpers.all.length, 1);
	await toolCall({ pi }, "read", { path: "/x" }, "r1");
	await toolCall({ pi }, "plan", { steps: [] }, "p1");
	assert.equal(desk.helpers.all.length, 1, "no helper for read or plan");
});

test("nested Agent calls (issued by another tool) do not spawn helpers", async () => {
	const { pi, desk } = boot();
	await pi.fire("tool_call", { type: "tool_call", toolName: "agent", input: { description: "x" }, toolCallId: "p0/1", parentToolCallId: "p0" }, fakeCtx());
	assert.equal(desk.helpers.all.length, 0);
});

test("an Agent launch is a main-loop tool call, so it can carry the nudge", async () => {
	const { pi } = boot();
	const r = await toolResult({ pi }, "agent", {}, { toolCallId: "a1" });
	assert.equal(contentLength(r), 2);
	assert.match((r!.content as any[])[1].text, /Helper Desk: no plan yet/);
});

// ---- Background vs foreground subagents (pi-subagents runs background by default) ----

test("a foreground Agent call (run_in_background: false) finishes its helper when the result lands", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "agent", { description: "Gate the edit", run_in_background: false }, "a1");
	await toolResult({ pi }, "agent", { description: "Gate the edit", run_in_background: false }, { toolCallId: "a1" });
	assert.equal(desk.helpers.finished.length, 1);
	assert.equal(desk.helpers.running.length, 0);
});

test("a background Agent call keeps its helper running after the spawn result", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "agent", { description: "Research notes", run_in_background: true }, "a1");
	await toolResult({ pi }, "agent", { description: "Research notes", run_in_background: true }, { toolCallId: "a1" });
	assert.equal(desk.helpers.finished.length, 0, "not finished: the real result comes later");
	assert.equal(desk.helpers.running.length, 1);
});

test("a background Agent call without the flag stays running too (background by default)", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "agent", { description: "Research notes" }, "a1");
	await toolResult({ pi }, "agent", { description: "Research notes" }, { toolCallId: "a1" });
	assert.equal(desk.helpers.running.length, 1);
});

test("collecting the result (get_subagent_result) finishes the waiting helpers", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "agent", { description: "One" }, "a1");
	await toolCall({ pi }, "agent", { description: "Two" }, "a2");
	await toolResult({ pi }, "agent", {}, { toolCallId: "a1" });
	await toolResult({ pi }, "agent", {}, { toolCallId: "a2" });
	assert.equal(desk.helpers.running.length, 2);
	await toolCall({ pi }, "get_subagent_result", { id: "a1" }, "g1");
	await toolResult({ pi }, "get_subagent_result", { id: "a1" }, { toolCallId: "g1" });
	assert.equal(desk.helpers.finished.length, 2, "both helpers were waiting on the collection");
	assert.equal(desk.helpers.running.length, 0);
});

test("an errored collection leaves the helpers running (the agent may still be at work)", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "agent", { description: "One" }, "a1");
	await toolResult({ pi }, "agent", {}, { toolCallId: "a1" });
	await toolCall({ pi }, "get_subagent_result", { id: "a1" }, "g1");
	await toolResult({ pi }, "get_subagent_result", { id: "a1" }, { toolCallId: "g1", isError: true });
	assert.equal(desk.helpers.running.length, 1);
});

// ---- Widget lifecycle ----

test("a plan saved with a UI sets the widget and it holds at 100%", async () => {
	const ctx = fakeCtx();
	ctx.hasUI = true;
	const { pi } = boot();
	await pi.tools[0].execute("p1", { title: "T", steps: [{ text: "a", status: "in_progress" }] }, undefined, undefined, ctx);
	assert.ok(ctx.ui.widgets.get("helper-desk:plan"), "the bar widget is set");
	await pi.tools[0].execute("p2", { title: "T", steps: [{ text: "a", status: "completed" }] }, undefined, undefined, ctx);
	assert.ok(ctx.ui.widgets.get("helper-desk:plan"), "the bar holds at 100%");
});

test("a UI-less context saves plans without touching widgets or toasts", async () => {
	const ctx = fakeCtx();
	const { pi } = boot();
	await pi.tools[0].execute("p1", { title: "T", steps: [{ text: "a", status: "in_progress" }] }, undefined, undefined, ctx);
	assert.equal(ctx.ui.widgets.size, 0);
	assert.equal(ctx.ui.notifications.length, 0);
});

test("a UI context gets toasts for finished steps and the whole plan", async () => {
	const ctx = fakeCtx();
	ctx.hasUI = true;
	const { pi } = boot();
	await pi.tools[0].execute("p1", { title: "T", steps: [{ text: "a", status: "in_progress" }] }, undefined, undefined, ctx);
	await pi.tools[0].execute("p2", { title: "T", steps: [{ text: "a", status: "completed" }] }, undefined, undefined, ctx);
	const messages = ctx.ui.notifications.map((n: any) => n.message).join(" | ");
	assert.match(messages, /Done: a/);
	assert.match(messages, /All steps done\.|All \d+ steps done\./);
});

test("session shutdown clears the widget", async () => {
	const ctx = fakeCtx();
	ctx.hasUI = true;
	const { pi } = boot();
	await pi.tools[0].execute("p1", { title: "T", steps: [{ text: "a", status: "in_progress" }] }, undefined, undefined, ctx);
	await pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);
	assert.equal(ctx.ui.widgets.size, 0);
});

// ---- Branch reconstruction ----

test("the plan rebuilds from the session branch on session_start", async () => {
	const details: PlanDetails = { title: "From the branch", steps: [{ text: "a", status: "in_progress" }] };
	const ctx = fakeCtx({
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "hi" } },
				{ type: "message", message: { role: "toolResult", toolName: "plan", details } },
			],
		},
	});
	ctx.hasUI = true;
	const { pi, desk } = boot();
	await pi.fire("session_start", { type: "session_start" }, ctx);
	assert.equal(desk.state.plan?.title, "From the branch");
	assert.ok(ctx.ui.widgets.get("helper-desk:plan"), "the bar redraws from the branch");
});

test("a foreign branch leaves no plan and no widget", async () => {
	const ctx = fakeCtx({
		sessionManager: {
			getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "read", details: { title: "X" } } }],
		},
	});
	ctx.hasUI = true;
	const { pi, desk } = boot();
	await pi.fire("session_start", { type: "session_start" }, ctx);
	assert.equal(desk.state.plan, null);
	assert.equal(ctx.ui.widgets.size, 0);
});

test("session_tree rebuilds too, so /tree lands on the right plan", async () => {
	const details: PlanDetails = { title: "After /tree", steps: [{ text: "a", status: "pending" }] };
	const ctx = fakeCtx({
		sessionManager: {
			getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "plan", details } }],
		},
	});
	ctx.hasUI = true;
	const { pi, desk } = boot();
	await pi.fire("session_tree", { type: "session_tree" }, ctx);
	assert.equal(desk.state.plan?.title, "After /tree");
	assert.ok(ctx.ui.widgets.get("helper-desk:plan"));
});

test("a new session clears the desk and the feed", async () => {
	const { pi, desk } = boot();
	await toolCall({ pi }, "agent", { description: "Research" }, "a1");
	assert.equal(desk.helpers.all.length, 1);
	await pi.fire("session_start", { type: "session_start" }, fakeCtx());
	assert.equal(desk.helpers.all.length, 0);
	assert.equal(desk.feed.length, 0);
});
