/**
 * pi-reflect — when you correct the agent, offers to save the fix as a lasting rule.
 *
 * Ported from the Reflect mod for Claude Code. After a run settles, the next input is
 * checked against correction heuristics ("no, …", "actually …", "revert …"). On a
 * correction, Reflect offers to save the fix as a rule: the suggestion is prefilled
 * (the correction minus its interjection), you confirm the text and where it lands —
 * the project's AGENTS.md or your global one — and it joins the Rules section,
 * deduplicated. /reflect saves a rule on demand.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCorrection, suggestRule } from "./correct.ts";
import { appendRule } from "./rules.ts";

export function createReflect(pi: ExtensionAPI) {
	// Armed by a settled run; a correction spends the offer once.
	let armed = false;

	pi.on("agent_settled", async (event) => {
		armed = !event.aborted;
	});

	pi.on("input", async (event, ctx) => {
		if (!armed || event.source !== "interactive") return;
		if (!isCorrection(event.text)) return;
		armed = false; // one offer per run, taken or not
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		const suggestion = suggestRule(event.text);
		if (!(await ctx.ui.confirm("Save this correction as a lasting rule?", suggestion))) return;
		const rule = await ctx.ui.input("The rule, in one line", suggestion);
		if (rule === undefined || !rule.trim()) return;
		const destination = await ctx.ui.select("Where should the rule live?", [
			`This project (${join(ctx.cwd, "AGENTS.md")})`,
			"Everywhere (~/.pi/agent/AGENTS.md)",
		]);
		const file = destination?.startsWith("Everywhere")
			? join(homedir(), ".pi", "agent", "AGENTS.md")
			: join(ctx.cwd, "AGENTS.md");
		try {
			appendRule(file, rule.trim());
			ctx.ui.notify(`Rule saved to ${file}`, "info");
		} catch (err) {
			ctx.ui.notify(`Could not save the rule: ${String(err)}`, "error");
		}
	});

	pi.registerCommand("reflect", {
		description: "Save a rule from this chat into AGENTS.md",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("/reflect needs interactive mode", "error");
				return;
			}
			const rule = await ctx.ui.input("A rule for the agent to keep following", "");
			if (!rule?.trim()) return;
			const destination = await ctx.ui.select("Where should the rule live?", [
				`This project (${join(ctx.cwd, "AGENTS.md")})`,
				"Everywhere (~/.pi/agent/AGENTS.md)",
			]);
			const file = destination?.startsWith("Everywhere")
				? join(homedir(), ".pi", "agent", "AGENTS.md")
				: join(ctx.cwd, "AGENTS.md");
			appendRule(file, rule.trim());
			ctx.ui.notify(`Rule saved to ${file}`, "info");
		},
	});
}

export default function reflect(pi: ExtensionAPI) {
	return createReflect(pi);
}
