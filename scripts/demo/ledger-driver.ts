/**
 * pi-ledger demo driver — scripted offline provider making 2 agent edits with
 * per-turn usage/cost that the ledger can capture.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EDITS = [
	{ path: "a.js", edits: [{ oldText: "const x = 1;", newText: "const x = 1;\nconst agentLine = 42; // added by the agent" }] },
	{ path: "b.js", edits: [{ oldText: "console.log('b');", newText: "console.log('b, agent-edited');" }] },
];

export default function (pi: ExtensionAPI) {
	pi.registerProvider("coedit-demo", {
		name: "coedit demo (scripted)",
		apiKey: "demo-key",
		api: "openai-completions" as Api,
		baseUrl: "http://127.0.0.1:1",
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
		await sleep(300);
		const toolResults = context.messages.filter((m) => m.role === "toolResult").length;
		let plan: { content: AssistantMessage["content"]; stopReason: "stop" | "toolUse" };
		if (toolResults < EDITS.length) {
			plan = { content: [{ type: "toolCall", id: `call_${toolResults + 1}`, name: "edit", arguments: EDITS[toolResults] }], stopReason: "toolUse" };
		} else {
			plan = { content: [{ type: "text", text: "Done — two agent edits made." }], stopReason: "stop" };
		}
		await emit(stream, plan, toolResults);
	})();
	return stream;
}

async function emit(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	plan: { content: AssistantMessage["content"]; stopReason: "stop" | "toolUse" },
	turn: number,
): Promise<void> {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-completions" as Api,
		provider: "coedit-demo",
		model: "claude-sonnet-4-5-demo",
		usage: {
			input: 12_000 + turn * 3_000,
			output: 800 + turn * 200,
			cacheRead: 40_000,
			cacheWrite: 0,
			totalTokens: 52_800 + turn * 3_200,
			cost: { input: 0.036, output: 0.0048, cacheRead: 0.006, cacheWrite: 0, total: 0.0468 + turn * 0.0112 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: output });
	for (const block of plan.content) {
		const contentIndex = output.content.length;
		output.content.push(block);
		if (block.type === "text") {
			stream.push({ type: "text_start", contentIndex, partial: output });
			stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
			stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
		} else {
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
			stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: output });
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
		}
	}
	output.stopReason = plan.stopReason;
	stream.push({ type: "done", reason: plan.stopReason, message: output });
	stream.end();
}
