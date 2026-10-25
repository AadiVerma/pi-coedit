/**
 * pi-handoff — writes a handoff prompt for the chat so a fresh session can pick up.
 *
 * Ported from the Handoff mod for Claude Code. `/handoff` digests the session branch
 * (goal, status, prompt digest, next step) into a markdown handoff, opens it in the
 * editor for review, and offers to start a fresh session with it loaded.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildHandoff } from "./handoff.ts";

export function createHandoff(pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Write a handoff prompt of this chat and start a fresh session with it",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("/handoff needs interactive mode", "error");
				return;
			}
			const usage = ctx.getContextUsage();
			const handoff = buildHandoff({
				entries: ctx.sessionManager.getBranch() as never,
				usage: usage ? { percent: usage.percent, tokens: usage.tokens } : undefined,
				model: ctx.model?.id,
			});
			const text = await ctx.ui.editor("Handoff prompt — edit or keep, escape to cancel", handoff.markdown);
			if (text === undefined) return;
			if (await ctx.ui.confirm("Start a fresh session with this handoff?", "The handoff is placed in the new chat's editor.")) {
				await ctx.newSession();
				try {
					ctx.ui.setEditorText(text);
				} catch {
					// A stale context after replacement: the user still has the text to paste.
				}
			}
		},
	});
}

export default function handoff(pi: ExtensionAPI) {
	return createHandoff(pi);
}
