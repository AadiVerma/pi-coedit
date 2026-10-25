/**
 * pi-chat-inventory — a pane listing what this chat used.
 *
 * Ported from the Chat Inventory mod for Claude Code. /inventory scans the session
 * branch and shows: prompt and tool-call counts, the plan with its progress, files read
 * and written, commands run, web sources, subagents launched, and skills used.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInventory } from "./inventory.ts";
import { InventoryPane } from "./pane.ts";

export function createChatInventory(pi: ExtensionAPI) {
	pi.registerCommand("inventory", {
		description: "Show what this chat used: files, commands, web, subagents, skills, plan",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/inventory requires interactive mode", "error");
				return;
			}
			const inv = buildInventory(ctx.sessionManager.getBranch() as never);
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
				const pane = new InventoryPane(inv, theme);
				return Object.assign(pane, { dispose: undefined });
			});
		},
	});
}

export default function chatInventory(pi: ExtensionAPI) {
	return createChatInventory(pi);
}
