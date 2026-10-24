/**
 * pi-ledger — pi plugin: capture per-turn usage, install/inspect the post-commit
 * hook, and run show/blame/range/report from inside pi.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Store, isRepo, repoInfo } from "@coedit/core";
import { recordTurnUsage, type TurnUsage } from "./ledger.ts";

export default function (pi: ExtensionAPI) {
	let store: Store | null = null;
	let sessionId = "";
	let storeDir: string | null = null;

	pi.on("session_start", async (_event, ctx) => {
		if (!isRepo(ctx.cwd)) return;
		const info = await repoInfo(ctx.cwd);
		store = await Store.open(info.toplevel, info.gitCommonDir);
		storeDir = store.dir;
		sessionId = ctx.sessionManager.getSessionId();
	});

	pi.on("session_shutdown", async () => {
		store = null;
		storeDir = null;
	});

	// turn_end carries the assistant message with its usage — attribute it to this turn.
	pi.on("turn_end", async (event, ctx) => {
		if (!storeDir || !sessionId) return;
		const msg = event.message as AssistantMessage;
		if (msg?.role !== "assistant" || !msg.usage) return;
		const usage: TurnUsage = {
			ts: new Date().toISOString(),
			turn: event.turnIndex,
			sessionId,
			model: msg.model ?? ctx.model?.id ?? "unknown",
			provider: msg.provider,
			input: msg.usage.input ?? 0,
			output: msg.usage.output ?? 0,
			cacheRead: msg.usage.cacheRead ?? 0,
			cacheWrite: msg.usage.cacheWrite ?? 0,
			costUsd: msg.usage.cost?.total ?? 0,
		};
		recordTurnUsage(storeDir, sessionId, usage);
	});

	pi.registerCommand("ledger", {
		description: "Agent cost per commit: /ledger install | show [commit] | blame <file> | range <base>..<head> | report [--since 30d] [--json]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "show";
			if (sub === "install") {
				if (ctx.hasUI && !(await ctx.ui.confirm("pi-ledger", "Install the post-commit hook that writes cost notes (refs/notes/pi-ledger)?"))) return;
				runCli(ctx, ["install"]);
				return;
			}
			runCli(ctx, [sub, ...parts.slice(1)]);
		},
	});
}

function runCli(ctx: ExtensionContext, cliArgs: string[]): void {
	const here = import.meta.dirname;
	// The bundled cli.js sits next to the bundled extension.
	const cli = join(here, "cli.js");
	if (!existsSync(cli)) {
		ctx.ui.notify("pi-ledger: cli.js missing — run npm run build", "warning");
		return;
	}
	const { status, stdout, stderr } = spawnSync(process.execPath, [cli, ...cliArgs], { cwd: ctx.cwd, encoding: "utf8" });
	const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
	if (out) ctx.ui.notify(out || "(no output)", status === 0 ? "info" : "warning");
}
