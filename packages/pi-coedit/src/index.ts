/**
 * pi-coedit — live human-vs-agent edit awareness for pi.
 *
 * - tells the model when the human edits files (context notes, once per change)
 * - blocks stale agent edit/write calls that would clobber human changes
 * - records every agent edit (edit/write/bash) with full session metadata
 * - footer: "✍️ you 3 files · 🤖 agent 7 · ⚠ 1 unknown" when something changed
 * - /whose [file], /coedit status|reset|doctor, and the read-only coedit_whose tool
 */
import * as fs from "node:fs";
import * as pathModule from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	classifyChange,
	computeHunks,
	contentHash,
	Coedit,
	formatHunks,
	gitAiPresent,
	headContent,
	type AgentMeta,
	type CoeditEvent,
	type Snapshot,
	splitLines,
} from "@coedit/core";

const IGNORED = [".git/", "node_modules/"];
const EDITOR_EVENT_WINDOW_MS = 8_000;
const MAX_NOTE_DIFF_CHARS = 2_000;
const MAX_WHOSE_LINES = 60;

interface PendingEdit {
	file: string;
	beforeContent: string;
	toolCallId: string;
}

export default function (pi: ExtensionAPI) {
	let coedit: Coedit | null = null;
	let fsWatcher: fs.FSWatcher | null = null;
	let watching = false;

	// agent-side state
	let sessionId = "";
	let sessionFile: string | undefined;
	let currentTurn = 0;
	let modelId: string | undefined;
	let lastPromptExcerpt: string | undefined;

	// per-file content hash after the agent last read/wrote it
	const lastAgentRead = new Map<string, string>();
	// files modified by the agent's own edit/write this session
	const agentTouched = new Set<string>();

	// bash window bookkeeping (parallel bash calls possible)
	let windowDepth = 0;
	let windowSnap: Snapshot | null = null;

	// edit/write in flight
	const pendingEdits = new Map<string, PendingEdit>();

	// snapshot at the last turn boundary, for out-of-window change detection
	let turnSnap: Snapshot | null = null;

	let currentCtx: ExtensionContext | undefined;

	function relPath(abs: string): string | null {
		if (!coedit) return null;
		const rel = pathModule.relative(coedit.worktree, abs);
		if (rel.startsWith("..") || pathModule.isAbsolute(rel)) return null;
		const posix = rel.split(pathModule.sep).join("/");
		if (IGNORED.some((p) => posix.includes(p))) return null;
		return posix;
	}

	function normalizeInputPath(input: unknown): string | null {
		const p = (input as { path?: string })?.path;
		if (!p || !coedit) return null;
		const abs = pathModule.isAbsolute(p) ? p : pathModule.resolve(coedit.worktree, p);
		return relPath(abs);
	}

	function agentMeta(toolCallId?: string): AgentMeta {
		return {
			sessionId,
			sessionFile,
			turn: currentTurn,
			toolCallId,
			model: modelId,
			promptExcerpt: coedit?.config.promptExcerpts ? lastPromptExcerpt : undefined,
		};
	}

	function readWorkFile(file: string): string | null {
		try {
			return fs.readFileSync(pathModule.join(coedit!.worktree, file), "utf8");
		} catch {
			return null;
		}
	}

	async function recordChange(
		file: string,
		author: "agent" | "human" | "unknown",
		source: CoeditEvent["source"],
		beforeContent: string | null,
		afterContent: string | null,
		toolCallId?: string,
	): Promise<void> {
		if (!coedit) return;
		const binary =
			(beforeContent !== null && beforeContent.includes("\0")) || (afterContent !== null && afterContent.includes("\0"));
		if (!binary && beforeContent !== null && afterContent !== null && beforeContent === afterContent) return;
		await coedit.recordEvent(
			{
				file,
				author,
				source,
				beforeHash: beforeContent === null ? null : contentHash(beforeContent),
				afterHash: afterContent === null ? null : contentHash(afterContent),
				binary,
				hunks: binary ? [] : computeHunks(splitLines(beforeContent ?? ""), splitLines(afterContent ?? "")),
				agent: author === "agent" ? agentMeta(toolCallId) : undefined,
			},
			{ before: beforeContent ?? undefined, after: afterContent ?? undefined },
		);
	}

	/** Latest recorded content of a file from the blob cache (null when unknown). */
	function lastKnownContent(file: string): string | null {
		if (!coedit) return null;
		const events = coedit.store.events({ worktree: coedit.worktree, file });
		const last = events[events.length - 1];
		return last?.afterHash ? coedit.store.getBlob(last.afterHash) : null;
	}

	function editorReportedRecently(file: string): boolean {
		if (!coedit) return false;
		const cutoff = Date.now() - EDITOR_EVENT_WINDOW_MS;
		return coedit
			.store.events({ worktree: coedit.worktree, file })
			.some((e) => e.source === "editor" && new Date(e.ts).getTime() > cutoff);
	}

	// ---------------------------------------------------------------- footer

	function updateFooter(): void {
		if (!coedit) return;
		const summary = coedit.fileSummary();
		const humanFiles = summary.filter((s) => s.human + s.both > 0).length;
		const agentFiles = summary.filter((s) => s.agent + s.both > 0).length;
		const unknownFiles = summary.filter((s) => s.unknown > 0).length;
		const parts: string[] = [];
		if (humanFiles > 0) parts.push(`✍️ you ${humanFiles} file${humanFiles === 1 ? "" : "s"}`);
		if (agentFiles > 0) parts.push(`🤖 agent ${agentFiles}`);
		if (unknownFiles > 0) parts.push(`⚠️ ${unknownFiles} unknown`);
		const text = parts.length > 0 ? parts.join(" · ") : undefined;
		if (currentCtx?.mode === "tui") {
			currentCtx.ui.setWidget("coedit", text ? [text] : undefined, { placement: "belowEditor" });
		}
	}

	// ---------------------------------------------------------------- session lifecycle

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		coedit = await Coedit.open(ctx.cwd);
		if (!coedit) {
			if (ctx.hasUI) ctx.ui.notify("coedit: not a git repository — staying inactive", "warning");
			return;
		}
		sessionId = ctx.sessionManager.getSessionId();
		sessionFile = ctx.sessionManager.getSessionFile();
		modelId = ctx.model?.id;
		await coedit.track();
		await coedit.store.markHead(coedit.head);

		// Store change → footer refresh (editor events from the gutter show up here too).
		coedit.onStoreChange(() => updateFooter());

		// Human-edit watcher. The gutter extension records `editor` events into the same
		// store; the editor signal is authoritative outside agent windows.
		try {
			fsWatcher = fs.watch(ctx.cwd, { recursive: true }, (_event, filename) => {
				void onFsChange(filename);
			});
			watching = true;
		} catch {
			watching = false;
		}
		updateFooter();
		if (ctx.hasUI) ctx.ui.notify("coedit: watching for human and agent edits", "info");
	});

	pi.on("session_shutdown", async () => {
		fsWatcher?.close();
		fsWatcher = null;
		watching = false;
		coedit?.close();
		coedit = null;
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "user") lastPromptExcerpt = event.prompt.slice(0, 200);
	});

	pi.on("model_select", async (event) => {
		modelId = event.model.id;
	});

	pi.on("turn_start", async (event) => {
		currentTurn = event.turnIndex;
		if (!coedit) return;
		// Checkpoint: changes since the last boundary that nobody recorded are human (rule 3a).
		const prev = turnSnap;
		turnSnap = await coedit.snapshot(prev ?? undefined);
		if (prev) await diffAndRecord(prev, turnSnap, { editorSeen: () => false }, false);
	});

	/** Diff two snapshots and record whatever no other path recorded yet. */
	async function diffAndRecord(
		before: Snapshot,
		after: Snapshot,
		opts: { editorSeen: (file: string) => boolean },
		agent: boolean,
	): Promise<void> {
		if (!coedit) return;
		const diff = coedit.diffSnapshots(before, after);
		coedit.applySnapshotDiff(diff);
		for (const file of [...diff.changed, ...diff.added]) {
			const afterContent = readWorkFile(file);
			if (afterContent === null) continue;
			const lastKnown = lastKnownContent(file);
			if (lastKnown === afterContent) continue; // fs-watch already recorded it
			const editorSeen = opts.editorSeen(file);
			// Inside an agent window: no editor report -> agent; editor report -> unknown
			// (human typing during the agent's command — never guessed). Outside: human.
			const author = agent
				? classifyChange({ editorSeenHuman: editorSeen, inAgentWindow: true })
				: classifyChange({ editorSeenHuman: editorSeen, inAgentWindow: false });
			await recordChange(file, author, agent ? "pi-bash" : "fs-watch", lastKnown, afterContent);
		}
		for (const file of diff.removed) {
			const events = coedit.store.events({ worktree: coedit.worktree, file });
			if (events[events.length - 1]?.afterHash === null) continue;
			await recordChange(file, agent ? "agent" : "human", agent ? "pi-bash" : "fs-watch", null, null);
		}
	}

	// ---------------------------------------------------------------- human edits via fs-watch

	async function onFsChange(filename: string | null): Promise<void> {
		if (!coedit || !filename) return;
		const file = relPath(pathModule.resolve(coedit.worktree, filename));
		if (!file) return;
		if (windowDepth > 0) return; // the window-close diff records it
		if (pendingEdits.size > 0) return; // our own agent edit lands via tool_execution_end
		await new Promise((r) => setTimeout(r, 250)); // debounce editor save bursts
		const after = readWorkFile(file);
		if (after === null) return; // deletion: recorded at the next snapshot boundary
		if (lastKnownContent(file) === after) return; // already recorded
		// Before-content: the last recorded version, else HEAD (tracked files).
		let before = lastKnownContent(file);
		if (before === null && coedit.head) {
			const headBuf = await headContent(coedit.worktree, file);
			before = headBuf ? headBuf.toString("utf8") : null;
		}
		await recordChange(file, "human", "fs-watch", before, after);
		updateFooter();
	}

	// ---------------------------------------------------------------- agent tool tracking

	pi.on("tool_execution_start", async (event) => {
		if (!coedit) return;
		if (event.toolName === "bash" || event.toolName === "powershell") {
			if (windowDepth === 0) windowSnap = await coedit.snapshot();
			windowDepth++;
		}
		if ((event.toolName === "edit" || event.toolName === "write") && !pendingEdits.has(event.toolCallId)) {
			const file = normalizeInputPath(event.args);
			if (file) {
				pendingEdits.set(event.toolCallId, {
					file,
					beforeContent: readWorkFile(file) ?? "",
					toolCallId: event.toolCallId,
				});
			}
		}
		if (event.toolName === "read") {
			const file = normalizeInputPath(event.args);
			if (file) {
				const content = readWorkFile(file);
				if (content !== null) {
					lastAgentRead.set(file, coedit.cacheContent(content));
					agentTouched.delete(file);
				}
			}
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (!coedit) return;
		if (event.toolName === "bash" || event.toolName === "powershell") {
			windowDepth = Math.max(0, windowDepth - 1);
			if (windowDepth === 0 && windowSnap) {
				const after = await coedit.snapshot();
				await diffAndRecord(windowSnap, after, { editorSeen: (f) => editorReportedRecently(f) }, true);
				windowSnap = null;
				updateFooter();
			}
		}
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			const pending = pendingEdits.get(event.toolCallId);
			pendingEdits.delete(event.toolCallId);
			if (pending) {
				const afterContent = readWorkFile(pending.file);
				await recordChange(
					pending.file,
					"agent",
					event.toolName === "edit" ? "pi-edit" : "pi-write",
					pending.beforeContent || null,
					afterContent,
					event.toolCallId,
				);
				if (afterContent !== null) lastAgentRead.set(pending.file, coedit.cacheContent(afterContent));
				agentTouched.add(pending.file);
				updateFooter();
			}
		}
	});

	// ---------------------------------------------------------------- overwrite guard

	pi.on("tool_call", async (event, ctx) => {
		if (!coedit || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const file = normalizeInputPath(event.input);
		if (!file) return;
		const currentContent = readWorkFile(file);
		if (agentTouched.has(file) && lastAgentRead.get(file) === (currentContent ? contentHash(currentContent) : "")) return;

		const policy = coedit.config.overwriteGuard;
		if (policy === "off") return;

		let stale = false;
		let diffText = "";
		const lastHash = lastAgentRead.get(file);
		if (lastHash) {
			const changes = await coedit.humanChangesSince(file, lastHash);
			stale = changes?.changed ?? false;
			diffText = changes?.diffText ?? "";
		} else {
			// Never read this session: stale if any human/unknown change exists after
			// the agent's most recent event for the file (or at all when none).
			const events = coedit.store.events({ worktree: coedit.worktree, file });
			let lastAgentIdx = -1;
			for (let i = events.length - 1; i >= 0; i--) {
				if (events[i].author === "agent") {
					lastAgentIdx = i;
					break;
				}
			}
			stale = events.some((e, i) => e.author !== "agent" && i > lastAgentIdx);
		}
		if (!stale) return;

		const reason = `coedit: "${file}" has human changes since you last read it. Re-read the file, merge the human changes, then retry.\n${diffText.slice(0, MAX_NOTE_DIFF_CHARS)}`;

		if (policy === "block") return { block: true, reason };
		if (policy === "warn") {
			if (ctx.hasUI) ctx.ui.notify(`coedit: allowing overwrite of human changes in ${file}`, "warning");
			return;
		}
		// policy === "ask" (default); fail closed without UI (print/JSON mode)
		if (!ctx.hasUI) return { block: true, reason };
		const choice = await ctx.ui.select(
			`coedit: human changes in ${file}`,
			["Re-read the file and merge (recommended)", "Allow anyway", "Cancel the edit"],
			{ timeout: 30_000 },
		);
		if (choice === "Allow anyway") {
			if (ctx.hasUI) ctx.ui.notify(`coedit: allowing overwrite of ${file}`, "warning");
			return;
		}
		return {
			block: true,
			reason: choice === "Cancel the edit" ? `coedit: the edit to ${file} was cancelled by the user.` : reason,
		};
	});

	// ---------------------------------------------------------------- human-edit notes

	pi.on("context", async (event) => {
		if (!coedit) return;
		const reported = new Set(coedit.store.getState().reportedHumanEvents);
		const pending = coedit
			.store.events({ worktree: coedit.worktree })
			.filter((e) => (e.author === "human" || e.author === "unknown") && e.file && !reported.has(e.id))
			.slice(-8);
		if (pending.length === 0) return;

		const byFile = new Map<string, CoeditEvent[]>();
		for (const e of pending) {
			const list = byFile.get(e.file) ?? [];
			list.push(e);
			byFile.set(e.file, list);
		}
		const parts: string[] = ["[coedit] The user edited these lines while you were working. Keep their changes."];
		for (const [file, evs] of byFile) {
			const current = readWorkFile(file);
			const baseHash = evs[0].beforeHash;
			const base = baseHash ? coedit.store.getBlob(baseHash) : null;
			let diffSection = "";
			if (base !== null && current !== null) {
				const hunks = computeHunks(splitLines(base), splitLines(current));
				diffSection = formatHunks(splitLines(base), splitLines(current), hunks, 30).slice(0, MAX_NOTE_DIFF_CHARS);
			}
			const label = evs.some((e) => e.author === "unknown")
				? "origin unclear (edited during an agent command)"
				: "human";
			parts.push(
				`\n${file} (${label})\n${diffSection || `(line detail unavailable — run /whose ${file})`}${
					diffSection.length >= MAX_NOTE_DIFF_CHARS ? `\n… truncated — full diff: /whose ${file}` : ""
				}`,
			);
		}
		parts.push("\n(Preserve these lines; per-line details via /whose.)");

		for (const e of pending) await coedit.store.markReported(e.id);
		return {
			messages: [...event.messages, { role: "user" as const, content: parts.join("\n"), timestamp: Date.now() }],
		};
	});

	// ---------------------------------------------------------------- commands & tool

	function whoseRender(file: string): string {
		if (!coedit) return "coedit inactive";
		const attr = coedit.engine.get(file);
		const content = readWorkFile(file);
		if (content === null) return `${file}: not readable`;
		const lines = splitLines(content);
		const icon: Record<string, string> = { human: "🟦", agent: "🟪", both: "🟧", unknown: "⬜", unchanged: "  " };
		const out: string[] = [`${file} — baseline: ${attr?.baseline ? attr.baseline.slice(0, 8) : "first-seen"}`];
		const eventsById = new Map(coedit.store.events({ worktree: coedit.worktree, file }).map((e) => [e.id, e]));
		const n = Math.min(lines.length, MAX_WHOSE_LINES);
		for (let i = 0; i < n; i++) {
			const line = attr?.lines[i];
			const origin = line?.origin ?? "unknown";
			let detail = "";
			if ((origin === "agent" || origin === "both") && line) {
				for (let k = line.events.length - 1; k >= 0; k--) {
					const ev = eventsById.get(line.events[k]);
					if (ev?.agent) {
						detail = ` [${ev.agent.sessionId.slice(0, 8)} t${ev.agent.turn ?? "?"}${ev.agent.model ? " " + ev.agent.model : ""}]`;
						break;
					}
				}
			}
			out.push(`${String(i + 1).padStart(4)} ${icon[origin]} ${origin.padEnd(9)} ${lines[i]}${detail}`);
		}
		if (lines.length > n) out.push(`… ${lines.length - n} more lines`);
		return out.join("\n");
	}

	pi.registerCommand("whose", {
		description: "Show per-line human/agent/both/unknown attribution for a file",
		handler: async (args, ctx) => {
			if (!coedit) {
				ctx.ui.notify("coedit is not active (not a git repo?)", "warning");
				return;
			}
			const file = normalizeInputPath({ path: args.trim() });
			if (!file) {
				ctx.ui.notify("usage: /whose <file>", "info");
				return;
			}
			await coedit.ensureFileState(file);
			ctx.ui.notify(whoseRender(file), "info");
		},
	});

	pi.registerCommand("coedit", {
		description: "coedit status | reset | doctor",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] || "status";
			if (!coedit) {
				ctx.ui.notify("coedit is not active (not a git repo?)", "warning");
				return;
			}
			if (sub === "status") {
				const summary = coedit.fileSummary();
				const lines = [
					`coedit status — store: ${coedit.store.dir}`,
					`head: ${coedit.head ? coedit.head.slice(0, 8) : "none"} · watcher: ${watching ? "running" : "stopped"}`,
					`policy: ${coedit.config.overwriteGuard} · git-ai notes on commit: ${coedit.config.gitaiAttachNotes}`,
				];
				for (const s of summary) {
					lines.push(`  ${s.file}: ✍️ ${s.human + s.both} · 🤖 ${s.agent + s.both}${s.unknown ? ` · ⚠️ ${s.unknown}` : ""}`);
				}
				if (summary.length === 0) lines.push("  no attributed changes yet");
				ctx.ui.notify(lines.join("\n"), "info");
			} else if (sub === "reset") {
				if (ctx.hasUI && !(await ctx.ui.confirm("coedit reset", "Forget all recorded coedit events for this repo?"))) return;
				fs.rmSync(pathModule.join(coedit.store.dir, "events.jsonl"), { force: true });
				fs.rmSync(pathModule.join(coedit.store.dir, "state.json"), { force: true });
				await coedit.track();
				ctx.ui.notify("coedit: store reset", "info");
			} else if (sub === "doctor") {
				const gitai = await gitAiPresent();
				let writable = false;
				try {
					const probe = pathModule.join(coedit.store.dir, ".doctor-probe");
					fs.writeFileSync(probe, "ok");
					fs.unlinkSync(probe);
					writable = true;
				} catch {
					/* not writable */
				}
				ctx.ui.notify(
					[
						"coedit doctor",
						`store: ${coedit.store.dir} — ${writable ? "writable ✓" : "NOT writable ✗"}`,
						`watcher: ${watching ? "running ✓" : "stopped ✗"}`,
						`git-ai: ${gitai ? `installed (${gitai}) — coedit stays read-only on refs/notes/ai` : "not installed — coedit may attach standard notes on commit"}`,
						`overwrite guard policy: ${coedit.config.overwriteGuard}`,
						`prompt excerpts: ${coedit.config.promptExcerpts ? "on (200 char cap)" : "off"}`,
					].join("\n"),
					"info",
				);
			} else {
				ctx.ui.notify("usage: /coedit status|reset|doctor", "info");
			}
		},
	});

	pi.registerTool({
		name: "coedit_whose",
		label: "coedit whose",
		description:
			"Read-only: show who wrote each line of a file (human / agent / both / unknown) with agent session details. Use it when the user asks who changed something or before claiming a file is untouched.",
		parameters: Type.Object({
			file: Type.String({ description: "Path relative to the repo root" }),
		}),
		execute: async (_toolCallId, params) => {
			if (!coedit) {
				return { content: [{ type: "text" as const, text: "coedit is not active in this session." }], details: undefined };
			}
			const file = normalizeInputPath({ path: params.file });
			if (!file) return { content: [{ type: "text" as const, text: `cannot resolve ${params.file}` }], details: undefined };
			await coedit.ensureFileState(file);
			return { content: [{ type: "text" as const, text: whoseRender(file) }], details: undefined };
		},
	});
}
