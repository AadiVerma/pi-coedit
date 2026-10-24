/**
 * coedit demo driver — a scripted offline provider so the demo can run pi's real
 * agent loop without model credentials.
 *
 * Turn plan:
 *   1. edit a.js (replace the TODO with a hello function).
 *   2. wait for the human edits to land (read a.js each turn; the coedit human-edit
 *      note must appear in the request context).
 *   3a. scenario "edit": acknowledge the human note. (default)
 *   3b. scenario "stale-edit": try a stale edit of a.js based on the pre-human
 *       content — the coedit guard must block it — then finish.
 *
 * Loaded alongside pi-coedit with:
 *   pi --mode json -e ./packages/pi-coedit -e scripts/demo/demo-driver.ts --model coedit-demo/scripted
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const scenario = process.env.COEDIT_DEMO_SCENARIO ?? "edit";

type Content = AssistantMessage["content"];

interface TurnPlan {
	content: Content;
	stopReason: "stop" | "toolUse";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The coedit human-edit note is injected into exactly ONE request (once per change),
// so remember having seen it — later requests no longer contain it.
let noteSeenOnce = false;

export default function (pi: ExtensionAPI) {
	pi.registerProvider("coedit-demo", {
		name: "coedit demo (scripted)",
		apiKey: "demo-key",
		api: "openai-completions" as Api,
		baseUrl: "http://127.0.0.1:1", // never contacted — streamSimple answers locally
		streamSimple: streamScripted,
		models: [
			{
				id: "scripted",
				name: "coedit demo scripted",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		],
	});
}

function streamScripted(_model: Model<Api>, context: TranscriptContext): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		await sleep(600); // give the concurrent human-edit script time each turn
		const messages = context.messages;
		if (process.env.COEDIT_DEMO_DEBUG) {
			const dump = messages
				.map((m) => `${m.role}:${Array.isArray(m.content) ? "blocks" : typeof m.content}:${
					typeof m.content === "string" ? m.content.slice(0, 60).replaceAll("\n", "⏎") : JSON.stringify(m.content).slice(0, 60)
				}`)
				.join("\n  ");
			process.stderr.write(`[driver] request messages:\n  ${dump}\n`);
		}
		const sawToolResult = messages.some((m) => m.role === "toolResult");
		if (messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("[coedit]"))) {
			noteSeenOnce = true;
		}
		const sawHumanNote = noteSeenOnce;
		const toolResultCount = messages.filter((m) => m.role === "toolResult").length;
		const triedStale = messages.some(
			(m) => m.role === "toolResult" && JSON.stringify(m).includes("overwrites the human"),
		);
		const staleBlocked = messages.some((m) => m.role === "toolResult" && JSON.stringify(m).includes("coedit:"));

		let plan: TurnPlan;
		if (!sawToolResult) {
			plan = toolCallPlan("call_edit_1", {
				path: "a.js",
				edits: [{ oldText: "// TODO: implement", newText: "function hello() {\n  return 'hi from the agent';\n}" }],
			});
		} else if (!sawHumanNote && toolResultCount < 10) {
			// Wait WITHOUT touching a.js (a read of a.js would refresh the agent's baseline
			// and legitimately disarm the overwrite guard) and WITHOUT bash (a bash window
			// would classify the human's edits as the agent's, per the detection rules).
			// Reading b.js passes the time and only refreshes b.js.
			plan = { content: [{ type: "toolCall", id: `call_wait_${toolResultCount}`, name: "read", arguments: { path: "b.js" } }], stopReason: "toolUse" };
		} else if (scenario === "stale-edit" && !triedStale && !staleBlocked) {
			// Stale: the human replaced the TODO region, so this oldText no longer matches —
			// but the guard must block the call before the edit tool even runs.
			plan = toolCallPlan("call_edit_2", {
				path: "a.js",
				edits: [{ oldText: "// TODO: implement", newText: "function hello() {\n  return 'overwrites the human!';\n}" }],
			});
		} else if (!sawHumanNote) {
			plan = textPlan("TIMEOUT: the coedit human note never arrived.");
		} else {
			plan = textPlan(
				scenario === "stale-edit" && staleBlocked
					? "The coedit guard blocked my stale edit (as it should). I also saw the user's edits and kept them."
					: "Acknowledged the user's edits; I kept them and merged my change around them.",
			);
		}
		await emit(stream, plan);
	})();
	return stream;
}

function toolCallPlan(id: string, args: Record<string, unknown>): TurnPlan {
	return {
		content: [{ type: "toolCall", id, name: "edit", arguments: args }],
		stopReason: "toolUse",
	};
}

function textPlan(text: string): TurnPlan {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

async function emit(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	plan: TurnPlan,
): Promise<void> {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-completions" as Api,
		provider: "coedit-demo",
		model: "scripted",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: output });
	for (const block of plan.content) {
		if (block.type === "text") {
			const contentIndex = output.content.length;
			output.content.push(block);
			stream.push({ type: "text_start", contentIndex, partial: output });
			stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
			stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
		} else {
			const contentIndex = output.content.length;
			output.content.push(block);
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
			stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: output });
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
		}
	}
	output.stopReason = plan.stopReason;
	stream.push({ type: "done", reason: plan.stopReason, message: output });
	stream.end();
}
