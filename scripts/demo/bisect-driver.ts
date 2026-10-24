/**
 * pi-bisect demo driver — scripted offline provider making 4 edits to util.js;
 * edit 3 breaks add(). Runs through pi's real agent loop so pi-bisect records
 * shadow commits the way it would in production.
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
	{ oldText: "module.exports.add = (a, b) => a + b;", newText: "// util helpers (edit 1)\nmodule.exports.add = (a, b) => a + b;" },
	{ oldText: "module.exports.add = (a, b) => a + b;", newText: "module.exports.add = (a, b) => a + b;\nmodule.exports.subtract10 = (n) => n - 10;" },
	{ oldText: "module.exports.add = (a, b) => a + b;", newText: "module.exports.add = (a, b) => a - b; // whoops" },
	{ oldText: "module.exports.subtract10 = (n) => n - 10;", newText: "module.exports.subtract10 = (n) => n - 10; // tested" },
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
		let plan;
		if (toolResults < EDITS.length) {
			plan = {
				content: [
					{
						type: "toolCall",
						id: `call_${toolResults + 1}`,
						name: "edit",
						arguments: { path: "util.js", edits: [EDITS[toolResults]] },
					},
				],
				stopReason: "toolUse" as const,
			};
		} else {
			plan = { content: [{ type: "text", text: "Done — made four improvements to util.js." }], stopReason: "stop" as const };
		}
		await emit(stream, plan);
	})();
	return stream;
}

async function emit(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	plan: { content: AssistantMessage["content"]; stopReason: "stop" | "toolUse" },
): Promise<void> {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-completions" as Api,
		provider: "coedit-demo",
		model: "scripted",
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
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
