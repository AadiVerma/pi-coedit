/**
 * pi-helper-desk — the agent's plan as a purple progress bar above the prompt.
 *
 * Ported from the Helper Desk mod for Claude Code. The `plan` tool carries its own
 * prompt guidelines, so the model is told to plan any task with 2+ steps; the plan
 * draws as a widget above the editor and `/helpers` opens the desk: a checklist, a π
 * pet card per subagent, and a kind-colored step feed. The plan lives in tool result
 * details and is rebuilt from the session branch, so forks and /tree land on the
 * right plan.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { barFactory } from "./bar.ts";
import { describe } from "./describe.ts";
import { HelperStore } from "./helpers.ts";
import { HelpersPane } from "./pane.ts";
import { PlanState, doneCount, readSteps, snapshot } from "./plan.ts";
import type { FeedItem, PlanDetails } from "./types.ts";

const WIDGET_KEY = "helper-desk:plan";
// How long a finished plan holds at 100% before the bar goes away.
const DONE_HOLD_MS = 20_000;
const FEED_MAX = 40;
// The tools @tintinweb/pi-subagents registers for launching subagents.
const SPAWN_TOOLS = new Set(["agent", "subagentworkflow"]);

const PlanParams = Type.Object({
	title: Type.Optional(Type.String({ description: "A short name for the job, a few words." })),
	steps: Type.Array(
		Type.Object({
			text: Type.String({ description: "The step in a few plain words." }),
			status: StringEnum(["pending", "in_progress", "completed"] as const, {
				description: "pending, in_progress or completed",
			}),
		}),
		{ description: "Every step, in order. Send the whole list every time." },
	),
});

/**
 * The whole extension: registers on `pi` and returns its desk state, so tests (and
 * curious extensions via pi.events) can observe it.
 */
export function createHelperDesk(pi: ExtensionAPI) {
	const state = new PlanState();
	const helpers = new HelperStore();
	const feed: FeedItem[] = [];
	let nudged = false;
	let holdTimer: ReturnType<typeof setTimeout> | null = null;

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			if (state.visible) ctx.ui.setWidget(WIDGET_KEY, barFactory(state), { placement: "aboveEditor" });
			else ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// A UI without widget support (RPC) just skips the bar.
		}
	};

	const scheduleHide = (ctx: ExtensionContext) => {
		if (holdTimer) clearTimeout(holdTimer);
		holdTimer = setTimeout(() => {
			holdTimer = null;
			state.shown = false;
			refresh(ctx);
		}, DONE_HOLD_MS);
	};

	/** Rebuild the desk from the session branch, so forks and /tree land on the right plan. */
	const reconstruct = (ctx: ExtensionContext) => {
		state.reset();
		helpers.clear();
		feed.length = 0;
		if (holdTimer) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message as { role?: string; toolName?: string; details?: unknown };
			if (msg.role !== "toolResult" || msg.toolName !== "plan") continue;
			const details = msg.details as PlanDetails | undefined;
			if (details && Array.isArray(details.steps)) state.adopt(details);
		}
		refresh(ctx);
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		if (holdTimer) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Nothing to clean up in modes without a widget.
		}
	});

	// A new run may nudge once more if it still works without a plan.
	pi.on("before_agent_start", async () => {
		nudged = false;
	});

	pi.on("tool_call", async (event) => {
		// Nested calls (issued by another tool) never enter the transcript; the desk
		// shows the chat, so they stay out of the feed too.
		if (event.parentToolCallId) return;
		const tool = event.toolName.toLowerCase();
		const { kind, label } = describe(event.toolName, event.input as Record<string, unknown>);
		if (SPAWN_TOOLS.has(tool)) helpers.spawn(event.toolCallId, label, Date.now());
		feed.push({ id: event.toolCallId, kind, label, done: false, at: Date.now() });
		if (feed.length > FEED_MAX) feed.splice(0, feed.length - FEED_MAX);
	});

	pi.on("tool_result", async (event) => {
		const item = [...feed].reverse().find((f) => f.id === event.toolCallId && !f.done);
		if (item) {
			item.done = true;
			if (event.isError) item.error = true;
		}
		const tool = event.toolName.toLowerCase();
		if (!event.parentToolCallId && SPAWN_TOOLS.has(tool)) {
			// pi-subagents runs agents in the background by default: the Agent result is
			// only a spawn confirmation, and the real result arrives via
			// get_subagent_result. A foreground call (run_in_background: false) blocks,
			// so its result is the real finish.
			const background = (event.input as Record<string, unknown> | undefined)?.run_in_background !== false;
			if (event.isError || !background) helpers.finish(event.toolCallId, event.isError, Date.now());
		}
		// Collecting a subagent's result is the deliberate "I want it now": whatever it
		// gathered for, those helpers are done. An errored collection leaves them running.
		if (tool === "get_subagent_result" && !event.isError) {
			for (const h of helpers.running) helpers.finish(h.id, false, Date.now());
		}

		// One nudge per run when the agent works without a plan: a short note on the
		// first tool result, read by the model only.
		if (nudged || tool === "plan" || event.isError || event.parentToolCallId) return;
		if (state.hasLivePlan()) return;
		nudged = true;
		return {
			content: [
				...event.content,
				{
					type: "text" as const,
					text: "Helper Desk: no plan yet for this task. Call the plan tool now with every step in order, so the user sees your progress.",
				},
			],
		};
	});

	pi.registerTool({
		name: "plan",
		label: "Plan",
		description:
			"Save the plan for the job in front of you: the steps in order, each pending, in_progress or completed. " +
			"It draws a progress bar above the prompt for the user. Send the whole list every time.",
		parameters: PlanParams,
		promptGuidelines: [
			"For any task that needs 2 or more steps or tool calls, call the plan tool first, before other tools, with every step in order and the first one in_progress.",
			"Call the plan tool again with the full list each time a step finishes or a new one starts, and mark the last step completed before your final answer.",
		],

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const read = readSteps(params.steps);
			if ("error" in read) {
				return {
					content: [{ type: "text", text: `Plan not saved: ${read.error}. Carry on.` }],
					details: snapshot(state.plan ?? { title: "Plan", steps: [] }),
				};
			}
			const applied = state.apply(params.title, read.steps);
			const n = state.plan!.steps.length;
			const done = doneCount(state.plan!.steps);
			if (ctx.hasUI) {
				try {
					if (applied.justDone.length) ctx.ui.notify(`Done: ${applied.justDone.join(", ")}`, "info");
					if (state.wasDone) {
						ctx.ui.notify(n === 1 ? "All steps done." : `All ${n} steps done.`, "info");
						scheduleHide(ctx);
					} else if (holdTimer) {
						clearTimeout(holdTimer);
						holdTimer = null;
					}
				} catch {
					// A toast is only a hint.
				}
			}
			refresh(ctx);
			return {
				content: [{ type: "text", text: `Plan saved: ${done} of ${n} steps done.` }],
				details: snapshot(state.plan!),
			};
		},

		renderCall(args, theme: Theme) {
			const n = Array.isArray(args?.steps) ? args.steps.length : 0;
			const title = typeof args?.title === "string" ? ` ${theme.fg("dim", args.title)}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("plan ")) + theme.fg("muted", `${n} steps`) + title, 0, 0);
		},

		renderResult(result, _options, theme: Theme) {
			const text = result.content.find((c) => c.type === "text");
			return new Text(theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	pi.registerCommand("helpers", {
		description: "Show the Helper Desk: the plan, a pet card per subagent, and the step feed",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/helpers requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const pane = new HelpersPane({
					state,
					helpers,
					feed,
					theme,
					done,
					now: () => Date.now(),
				});
				// The pets hop while the pane is open; stop when it closes.
				const timer = setInterval(() => {
					pane.invalidate();
					tui.requestRender();
				}, 600);
				return Object.assign(pane, {
					dispose() {
						clearInterval(timer);
					},
				});
			});
			refresh(ctx);
		},
	});

	return { state, helpers, feed };
}

export default function helperDesk(pi: ExtensionAPI) {
	return createHelperDesk(pi);
}
