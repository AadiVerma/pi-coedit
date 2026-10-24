import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("__NAME__", {
		description: "__DESCRIPTION__",
		handler: async (_args, ctx) => {
			ctx.ui.notify("__NAME__ loaded", "info");
		},
	});
}
