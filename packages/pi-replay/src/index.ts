/**
 * pi-replay — steps through the chat's file edits, one diff at a time.
 *
 * Ported from the Replay Theater mod for Claude Code (Anthropic's sample, Apache 2.0).
 * /replay collects every edit and write result from the session branch — each carries
 * a display diff in its details — and steps through them with the arrow keys.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectEdits } from "./edits.ts";
import { ReplayPane } from "./pane.ts";

export function createReplay(pi: ExtensionAPI) {
	pi.registerCommand("replay", {
		description: "Step through this chat's file edits, one diff at a time",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/replay requires interactive mode", "error");
				return;
			}
			const steps = collectEdits(ctx.sessionManager.getBranch() as never);
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => new ReplayPane(steps, theme, done));
		},
	});
}

export default function replay(pi: ExtensionAPI) {
	return createReplay(pi);
}
