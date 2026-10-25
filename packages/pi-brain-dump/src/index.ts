/**
 * pi-brain-dump — catches a long, loose prompt before it is sent.
 *
 * Ported from the Brain Dump mod for Claude Code. When a prompt is long (25+ words)
 * and has no structure, Brain Dump gates the send, asks up to three questions about
 * what the prompt leaves out (files, done, guardrails — only for the signals it does
 * not already carry), and fills the editor with a four-part brief: the job, the why,
 * the guardrails, done means. The user reviews it and presses Enter. Escape on the
 * first question cancels the interception and sends the original text unchanged.
 * /brain-dump toggles it off and on.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildBrief, type BriefAnswers } from "./brief.ts";
import { gapQuestions, shouldIntercept, type QuestionKind } from "./classify.ts";

/**
 * The whole extension; returns its state so tests (and curious extensions) can observe.
 */
export function createBrainDump(pi: ExtensionAPI) {
	let enabled = true;

	pi.on("input", async (event, ctx) => {
		if (!enabled) return;
		if (event.source !== "interactive") return;
		if (!shouldIntercept(event.text)) return;
		// Dialogs need a real terminal; in print or rpc mode the prompt flows untouched.
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		const questions = gapQuestions(event.text);
		const answers: BriefAnswers = {};
		for (const [i, gap] of questions.entries()) {
			const answer = await ctx.ui.input(gap.question, "Type an answer, or press Enter to skip");
			if (answer === undefined) {
				if (i === 0) return; // Escape on the first question: cancel, send the original.
				break; // Escape later: skip the remaining questions.
			}
			answers[gap.kind as QuestionKind] = answer.trim();
		}
		ctx.ui.setEditorText(buildBrief(event.text, answers));
		return { action: "handled" as const };
	});

	pi.registerCommand("brain-dump", {
		description: "Toggle Brain Dump: catch long, loose prompts and turn them into four-part briefs",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(
				enabled
					? "Brain Dump is on: long, loose prompts get the four-part treatment."
					: "Brain Dump is off: prompts send as typed.",
				"info",
			);
		},
	});

	return {
		get enabled() {
			return enabled;
		},
	};
}

export default function brainDump(pi: ExtensionAPI) {
	return createBrainDump(pi);
}
