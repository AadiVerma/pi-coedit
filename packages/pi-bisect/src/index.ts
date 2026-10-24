/**
 * pi-bisect — find the agent edit that broke a command.
 *
 * After every agent change (edit/write/bash) the whole worktree is snapshotted
 * as a plumbing commit under refs/coedit/edits/<sessionId>. `/bisect "<cmd>"`
 * binary-searches those snapshots in a throwaway detached worktree and produces
 * a result card: culprit diff, turn, prompt, model, and actions (revert this
 * edit / ask the agent to fix it / jump to the session tree).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as pathModule from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyPatch, commitMessage, diffSnapshots, emptySnapshot, Store, takeSnapshot } from "@coedit/core";
import { bisect, parseTimeout, type BisectProgress } from "./bisect.ts";
import { ShadowHistory, type ShadowMeta } from "./shadow.ts";

const exec = promisify(execFile);

export default function (pi: ExtensionAPI) {
	let history: ShadowHistory | null = null;
	let sessionId = "";
	let store: Store | null = null;
	let promptExcerpt: string | undefined;
	let modelId: string | undefined;
	let turn = 0;

	// bash window bookkeeping
	let windowDepth = 0;
	let windowSnap: ReturnType<typeof emptySnapshot> | null = null;
	// edit/write targets captured at start (end events carry no args)
	const editTargets = new Map<string, string>();

	pi.on("session_start", async (_event, ctx) => {
		if (!store) {
			const { isRepo, repoInfo } = await import("@coedit/core");
			if (!isRepo(ctx.cwd)) return;
			const info = await repoInfo(ctx.cwd);
			store = await Store.open(info.toplevel, info.gitCommonDir);
		}
		sessionId = ctx.sessionManager.getSessionId();
		history = new ShadowHistory(store.worktree, store.dir, sessionId);
		modelId = ctx.model?.id;
	});

	pi.on("session_shutdown", async () => {
		history = null;
		store = null;
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "user") promptExcerpt = event.prompt.slice(0, 200);
	});

	pi.on("turn_start", async (event) => {
		turn = event.turnIndex;
	});

	pi.on("tool_execution_start", async (event) => {
		if (!store) return;
		if (event.toolName === "bash" || event.toolName === "powershell") {
			if (windowDepth === 0) windowSnap = await takeSnapshot(store.worktree);
			windowDepth++;
		}
		if (event.toolName === "edit" || event.toolName === "write") {
			const file = normalizePath(event.args?.path, store.worktree);
			if (file) editTargets.set(event.toolCallId, file);
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (!history || !store) return;
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			const file = editTargets.get(event.toolCallId) ?? null;
			editTargets.delete(event.toolCallId);
			await history.record({
				turn,
				toolCallId: event.toolCallId,
				tool: event.toolName,
				files: file ? [file] : [],
				model: modelId,
				promptExcerpt,
			});
		}
		if (event.toolName === "bash" || event.toolName === "powershell") {
			windowDepth = Math.max(0, windowDepth - 1);
			if (windowDepth === 0 && windowSnap) {
				const after = await takeSnapshot(store.worktree);
				const diff = diffSnapshots(windowSnap, after);
				const files = [...diff.changed, ...diff.added, ...diff.removed, ...diff.renamed.map(([, to]) => to)];
				if (files.length > 0) {
					await history.record({ turn, toolCallId: event.toolCallId, tool: "bash", files, model: modelId, promptExcerpt });
				}
				windowSnap = null;
			}
		}
	});

	pi.registerCommand("bisect", {
		description:
			'Find the agent edit that broke a command: /bisect "npm test" [--from <sha|turn:N>] [--runs N] [--timeout 5m] [--revert] [--fix] | /bisect gc',
		handler: async (args, ctx) => {
			if (!history || !store) {
				ctx.ui.notify("pi-bisect: not active (not a git repo?)", "warning");
				return;
			}
			const parsed = parseArgs(args);
			if (parsed.subcommand === "gc") {
				await gc(ctx, store.worktree);
				return;
			}
			if (!parsed.command) {
				ctx.ui.notify('usage: /bisect "npm test" [--from turn:3] [--runs 2] [--timeout 5m] [--revert] [--fix]', "info");
				return;
			}
			await runBisect(pi, ctx, { store, history, sessionId, args: parsed });
		},
	});
}

// ---------------------------------------------------------------- plumbing

function normalizePath(p: unknown, worktree: string): string | null {
	if (typeof p !== "string" || p.length === 0) return null;
	const abs = pathModule.isAbsolute(p) ? p : pathModule.resolve(worktree, p);
	const rel = pathModule.relative(worktree, abs);
	if (rel.startsWith("..") || pathModule.isAbsolute(rel)) return null;
	return rel.split(pathModule.sep).join("/");
}

interface BisectArgs {
	subcommand?: "gc";
	command?: string;
	from?: string;
	runs: number;
	timeoutMs: number;
	revert: boolean;
	fix: boolean;
}

function parseArgs(raw: string): BisectArgs {
	const out: BisectArgs = { runs: 1, timeoutMs: 300_000, revert: false, fix: false };
	if (raw.trim().startsWith("gc")) {
		out.subcommand = "gc";
		return out;
	}
	const match = /"([^"]+)"|^(\S+)/.exec(raw.trim());
	out.command = match?.[1] ?? match?.[2];
	for (const [key, value] of raw.matchAll(/--(\w+)(?:[=\s](?:"([^"]*)"|(\S+)))?/g)) {
		if (key === "from") out.from = value ?? "";
		if (key === "runs") out.runs = Math.max(1, Number(value ?? 1));
		if (key === "timeout") out.timeoutMs = parseTimeout(value);
		if (key === "revert") out.revert = true;
		if (key === "fix") out.fix = true;
	}
	return out;
}

/**
 * Run `command` in a throwaway detached worktree at `sha`, `runs` times.
 * Any failing run (non-zero exit or timeout) marks the snapshot bad.
 * Worktrees are always cleaned up, even on error.
 */
async function runCommandInSnapshot(
	repo: string,
	sha: string,
	command: string,
	timeoutMs: number,
	runs: number,
): Promise<{ pass: boolean; output: string }> {
	const dir = mkdtempSync(pathModule.join(tmpdir(), "coedit-bisect-"));
	try {
		await exec("git", ["worktree", "add", "--detach", "--quiet", dir, sha], { cwd: repo });
		const outputs: string[] = [];
		let pass = true;
		for (let i = 0; i < runs; i++) {
			try {
				const res = await exec("/bin/bash", ["-c", command], { cwd: dir, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
				outputs.push([res.stdout ?? "", res.stderr ?? ""].join("\n").slice(-1500));
			} catch (e) {
				const err = e as { stdout?: string; stderr?: string; killed?: boolean };
				pass = false;
				outputs.push([err.stdout ?? "", err.stderr ?? "", err.killed ? "(timed out)" : ""].join("\n").slice(-1500));
			}
		}
		return { pass, output: outputs.join("\n---\n") };
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* git worktree remove below still works */
		}
		try {
			await exec("git", ["worktree", "remove", "--force", dir], { cwd: repo });
		} catch {
			try {
				await exec("git", ["worktree", "prune"], { cwd: repo });
			} catch {
				/* nothing to prune */
			}
		}
	}
}

async function runBisect(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { store: Store; history: ShadowHistory; sessionId: string; args: BisectArgs },
): Promise<void> {
	const { store, history, sessionId, args } = opts;
	const allMetas = await history.history();
	let metas = allMetas;
	if (args.from) {
		const fromIdx = fromIndex(allMetas, args.from);
		if (fromIdx < 0) {
			ctx.ui.notify(`pi-bisect: --from ${args.from} matched no snapshot`, "warning");
			return;
		}
		metas = allMetas.slice(fromIdx);
	}
	if (metas.length < 2) {
		ctx.ui.notify("pi-bisect: fewer than 2 shadow snapshots in range — nothing to bisect", "warning");
		return;
	}

	const started = Date.now();
	const progress = (p: BisectProgress) => {
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(
				"coedit-bisect",
				[`⏳ bisect: step ${p.step} · range ${p.hi - p.lo} of ${metas.length} left · testing #${p.testing} · ${((Date.now() - started) / 1000).toFixed(0)}s`],
				{ placement: "belowEditor" },
			);
		}
	};

	const result = await bisect(
		metas.map((m) => m.sha),
		async (sha) => (await runCommandInSnapshot(store.worktree, sha, args.command!, args.timeoutMs, args.runs)).pass,
		progress,
	);

	if (ctx.mode === "tui") ctx.ui.setWidget("coedit-bisect", undefined);

	if (!result.ok) {
		ctx.ui.notify(`pi-bisect: ${result.reason} (${result.steps} command run(s), ${elapsed(started)})`, "warning");
		return;
	}
	const culprit = metas[result.foundIndex];
	const card = await resultCard(store.worktree, metas, culprit, sessionId, args.command!, started);
	ctx.ui.notify(card, "info");

	if (ctx.hasUI && !args.revert && !args.fix) {
		const choice = await ctx.ui.select("pi-bisect: what next?", ["Show the agent the culprit (fix it)", "Revert only this edit", "Nothing"], { timeout: 60_000 });
		if (choice === "Revert only this edit") await revertCulprit(ctx, store.worktree, metas, result.foundIndex);
		else if (choice === "Show the agent the culprit (fix it)") sendFixIt(pi, card);
	} else {
		if (args.revert) await revertCulprit(ctx, store.worktree, metas, result.foundIndex);
		if (args.fix) sendFixIt(pi, card);
	}
}

function fromIndex(metas: ShadowMeta[], from: string): number {
	if (from.startsWith("turn:")) {
		const t = Number(from.slice(5));
		const i = metas.findIndex((m) => m.turn >= t);
		return i < 0 ? metas.length : i;
	}
	return metas.findIndex((m) => m.sha.startsWith(from));
}

async function resultCard(repo: string, metas: ShadowMeta[], culprit: ShadowMeta, sessionId: string, command: string, started: number): Promise<string> {
	const idx = metas.findIndex((m) => m.sha === culprit.sha);
	const parent = idx > 0 ? metas[idx - 1] : null;
	let diffText = "";
	if (parent) {
		try {
			const { stdout } = await exec("git", ["diff", parent.sha, culprit.sha, "--"], { cwd: repo, maxBuffer: 4 * 1024 * 1024 });
			diffText = stdout.split("\n").slice(0, 40).join("\n");
		} catch {
			/* fall through */
		}
	} else {
		diffText = "(first snapshot — everything is new)";
	}
	const editsAgo = metas.length - 1 - idx;
	const message = await commitMessage(repo, culprit.sha).catch(() => "");
	return [
		`🎯 pi-bisect culprit — edit #${idx + 1} of ${metas.length} (${editsAgo} edit(s) ago)`,
		`command: ${command}`,
		`turn: ${culprit.turn} · tool: ${culprit.tool} · files: ${culprit.files.join(", ") || "?"}`,
		`model: ${culprit.model ?? "?"} · session: ${sessionId.slice(0, 12)}`,
		culprit.promptExcerpt ? `prompt: “${culprit.promptExcerpt}”` : "",
		`commit: ${culprit.sha.slice(0, 10)} ${message.split("\n")[0] ?? ""}`,
		`session tree: /tree (jump to turn ${culprit.turn})`,
		"",
		diffText || "(no textual diff)",
		"",
		`found in ${elapsed(started)}`,
	].join("\n");
}

function sendFixIt(pi: ExtensionAPI, card: string): void {
	pi.sendMessage(
		{
			customType: "pi-bisect",
			content: `Bisect found the edit that broke the command. Fix it without touching the human's changes:\n\n${card}`,
			display: true,
		},
		{ triggerTurn: true, deliverAs: "nextTurn" },
	);
}

async function revertCulprit(ctx: ExtensionContext, repo: string, metas: ShadowMeta[], foundIndex: number): Promise<void> {
	const culprit = metas[foundIndex];
	const parent = foundIndex > 0 ? metas[foundIndex - 1] : null;
	if (!parent) {
		ctx.ui.notify("pi-bisect: cannot revert the first snapshot", "warning");
		return;
	}
	try {
		const { stdout } = await exec("git", ["diff", "--binary", parent.sha, culprit.sha, "--"], { cwd: repo, maxBuffer: 8 * 1024 * 1024 });
		const reverse = invertPatchSides(stdout);
		const applied = await applyPatch(repo, reverse);
		if (applied.applied) {
			ctx.ui.notify(`pi-bisect: reverted the culprit edit (${applied.mode} apply). Verify the file.`, "info");
			return;
		}
	} catch {
		/* fall through to the content-anchored revert */
	}
	const { revertEdit } = await import("./revert.ts");
	const result = await revertEdit(repo, culprit, parent);
	if (result.filesChanged.length > 0) {
		ctx.ui.notify(
			`pi-bisect: reverted the culprit edit in ${result.filesChanged.join(", ")}${result.conflicts.length > 0 ? ` — ${result.conflicts.length} hunk(s) conflicted, review the file` : ""}`,
			result.conflicts.length > 0 ? "warning" : "info",
		);
	} else {
		ctx.ui.notify(`pi-bisect: revert FAILED — ${result.conflicts.join("; ")}`, "warning");
	}
}

/** Swap a/b sides of a `git diff A B` patch so applying it reverses the change. */
function invertPatchSides(patch: string): string {
	return patch
		.replace(/^--- a\/(.*)$/gm, "___TMP___ $1")
		.replace(/^\+\+\+ b\/(.*)$/gm, "+++ b/$1")
		.replace(/^___TMP___ (.*)$/gm, "--- a/$1")
		.replace(/^diff --git a\/(\S+) b\/(\S+)$/gm, "diff --git a/$2 b/$1");
}

async function gc(ctx: ExtensionContext, repo: string): Promise<void> {
	const refs = await listShadowRefs(repo);
	if (refs.length === 0) {
		ctx.ui.notify("pi-bisect: no shadow refs to collect", "info");
		return;
	}
	const keep = 10;
	const sorted = [...refs].sort((a, b) => b.date - a.date);
	let removed = 0;
	for (const r of sorted.slice(keep)) {
		await exec("git", ["update-ref", "-d", r.ref], { cwd: repo }).catch(() => undefined);
		removed++;
	}
	ctx.ui.notify(`pi-bisect gc: kept ${Math.min(keep, sorted.length)} session ref(s), removed ${removed}`, "info");
}

interface RefInfo {
	ref: string;
	date: number;
}

async function listShadowRefs(repo: string): Promise<RefInfo[]> {
	try {
		const { stdout } = await exec("git", ["for-each-ref", "--format=%(refname) %(committerdate:unix)", "refs/coedit/edits/"], { cwd: repo });
		return stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [ref, date] = line.split(" ");
				return { ref, date: Number(date) * 1000 };
			});
	} catch {
		return [];
	}
}

function elapsed(started: number): string {
	const s = (Date.now() - started) / 1000;
	return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`;
}
