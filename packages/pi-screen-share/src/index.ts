/**
 * pi-screen-share — masks sensitive strings on screen while you record.
 *
 * Ported from the Screen Share mod for Claude Code. /screen-share toggles a markdown
 * transformer: emails, phone numbers, card numbers, IP addresses and money amounts draw
 * as blocks, URLs keep only their host, code stays untouched. The model still reads the
 * real data — only the screen changes. /screen-share toggles it off and on.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { maskSensitive } from "./mask.ts";

export function createScreenShare(pi: ExtensionAPI) {
	let enabled = false;

	pi.registerCommand("screen-share", {
		description: "Toggle screen masking: emails, phones, cards, IPs and money draw as blocks",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(
				enabled
					? "Screen Share is on: sensitive values draw as blocks. The model still reads the real data."
					: "Screen Share is off: everything draws as-is.",
				"info",
			);
		},
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		// The user knows what they typed; only the agent's output is masked.
		if (!enabled || context.messageType === "user") return markdown;
		return maskSensitive(markdown);
	});
}

export default function screenShare(pi: ExtensionAPI) {
	return createScreenShare(pi);
}
