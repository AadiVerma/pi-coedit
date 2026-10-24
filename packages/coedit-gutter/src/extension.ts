/**
 * coedit-gutter — VS Code extension (also runs in Cursor/Windsurf).
 *
 * - colours lines by author, live, before commit: 🟦 human · 🟪 agent · 🟧 both · ⬜ unknown
 * - acts as the authoritative human sensor: keystroke edits are recorded as human
 *   (unsaved edits shown immediately, written to the store on save)
 * - hover on agent lines: session, turn, model, prompt excerpt, time
 * - status bar: ✍️ 42 · 🤖 118 for the active file
 * - commands: next/previous agent change, revert agent changes (file / selection),
 *   toggle colours, show /whose
 */
import * as pathModule from "path";
import * as vscode from "vscode";
import { computeHunks, contentHash, Coedit, headCommit, type FileSummary, splitLines } from "@coedit/core";
import { counts, mapAttributionToRanges, nextAgentLine, overlayUnsaved, prevAgentLine, type DecorationRanges } from "./decoration-map.ts";
import { computeAgentRevert, type RevertEvent } from "./revert-core.ts";

interface WorkspaceState {
	folder: vscode.WorkspaceFolder;
	coedit: Coedit | null;
	disposables: vscode.Disposable[];
	/** unsaved keystroke edits per file: line indexes typed since the last save */
	unsaved: Map<string, Set<number>>;
	/** last saved content per file (for computing save hunks) */
	lastSaved: Map<string, string>;
	rerenderTimer: ReturnType<typeof setTimeout> | undefined;
	decorations: Map<keyof DecorationRanges, vscode.TextEditorDecorationType>;
	enabled: boolean;
	statusItem: vscode.StatusBarItem;
}

const states: WorkspaceState[] = [];
let lastRevertAt = 0;
let lastRevertUri: vscode.Uri | undefined;

export function activate(context: vscode.ExtensionContext): void {
	rebuildStates();
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => rebuildStates()),
		vscode.window.onDidChangeActiveTextEditor(() => rerenderAll()),
		vscode.workspace.onDidChangeTextDocument(onDidChangeTextDocument),
		vscode.workspace.onDidSaveTextDocument(onDidSave),
		vscode.workspace.onDidCloseTextDocument((doc) => clearUnsaved(doc)),
		vscode.languages.registerHoverProvider({ scheme: "file" }, { provideHover }),
		{
			dispose: () => {
				for (const st of states) teardownState(st);
				states.length = 0;
			},
		} as vscode.Disposable,
	);
	registerCommands(context);
}

function rebuildStates(): void {
	for (const st of states) teardownState(st);
	states.length = 0;
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const st: WorkspaceState = {
			folder,
			coedit: null,
			disposables: [],
			unsaved: new Map(),
			lastSaved: new Map(),
			rerenderTimer: undefined,
			decorations: buildDecorations(),
			enabled: true,
			statusItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 60),
		};
		states.push(st);
		void initState(st);
	}
}

function buildDecorations(): Map<keyof DecorationRanges, vscode.TextEditorDecorationType> {
	const cfg = vscode.workspace.getConfiguration("coedit");
	const make = (color: string, overview: string) => {
		const icon = vscode.Uri.parse(
			`data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="4" height="16"><rect x="0" y="0" width="4" height="16" rx="1" fill="${color}"/></svg>`,
		);
		return vscode.window.createTextEditorDecorationType({
			gutterIconPath: icon,
			overviewRulerColor: overview,
			overviewRulerLane: vscode.OverviewRulerLane.Left,
			backgroundColor: cfg.get<boolean>("showBackground") ? `${color}22` : undefined,
		});
	};
	const map = new Map<keyof DecorationRanges, vscode.TextEditorDecorationType>();
	map.set("human", make(cfg.get<string>("colorHuman", "#4A90D9"), "rgba(74,144,217,0.9)"));
	map.set("agent", make(cfg.get<string>("colorAgent", "#9B59D0"), "rgba(155,89,208,0.9)"));
	map.set("both", make(cfg.get<string>("colorBoth", "#E8923A"), "rgba(232,146,58,0.9)"));
	map.set("unknown", make(cfg.get<string>("colorUnknown", "#9AA0A6"), "rgba(154,160,166,0.7)"));
	return map;
}

async function initState(st: WorkspaceState): Promise<void> {
	const override = vscode.workspace.getConfiguration("coedit").get<string>("storePath", "").trim();
	st.coedit = await Coedit.open(st.folder.uri.fsPath, override ? { storeDir: override } : undefined);
	if (!st.coedit) return; // not a git repo
	await st.coedit.track();
	st.disposables.push(
		(() => {
			const unsub = st.coedit!.onStoreChange(() => {
				if (st.rerenderTimer) clearTimeout(st.rerenderTimer);
				st.rerenderTimer = setTimeout(() => {
					void (async () => {
						// HEAD moved (a commit landed): committed lines return to
						// unchanged so decorations don't go stale after commits.
						if (st.coedit) {
							const head = await headCommit(st.folder.uri.fsPath);
							if (head && head !== st.coedit.head) await st.coedit.resetBaseline(head);
						}
						rerenderAll();
					})();
				}, vscode.workspace.getConfiguration("coedit").get<number>("debounceMs", 300));
			});
			return { dispose: unsub } as vscode.Disposable;
		})(),
	);
	rerenderAll();
}

function teardownState(st: WorkspaceState): void {
	for (const d of st.disposables) d.dispose();
	st.coedit?.close();
	st.coedit = null;
	st.statusItem.dispose();
	st.decorations.forEach((d) => d.dispose());
}

function stateForDoc(doc: vscode.TextDocument): WorkspaceState | null {
	for (const st of states) {
		const fsPath = st.folder.uri.fsPath;
		if (doc.uri.fsPath === fsPath || doc.uri.fsPath.startsWith(fsPath + pathModule.sep)) return st;
	}
	return null;
}

function relFile(st: WorkspaceState, uri: vscode.Uri): string | null {
	const rel = pathModule.relative(st.folder.uri.fsPath, uri.fsPath);
	if (rel.startsWith("..") || pathModule.isAbsolute(rel)) return null;
	return rel.split(pathModule.sep).join("/");
}

// ---------------------------------------------------------------- rendering

function rerenderAll(): void {
	vscode.window.visibleTextEditors.forEach((editor) => rerender(editor));
}

function rerender(editor: vscode.TextEditor): void {
	const st = stateForDoc(editor.document);
	if (!st) return;
	const file = relFile(st, editor.document.uri);
	if (!file || !st.enabled || !st.coedit) {
		for (const deco of st.decorations.values()) editor.setDecorations(deco, []);
		if (st && vscode.window.activeTextEditor === editor) st.statusItem.hide();
		return;
	}
	const coedit = st.coedit;
	const hasEvents = coedit.store.events({ worktree: coedit.worktree, file }).length > 0;
	const attr = coedit.engine.get(file);
	let ranges = mapAttributionToRanges(hasEvents || attr ? attr : undefined, editor.document.lineCount, hasEvents);
	ranges = overlayUnsaved(ranges, st.unsaved.get(file) ?? new Set());
	for (const [origin, deco] of st.decorations) {
		const validLines = ranges[origin].filter((line) => line < editor.document.lineCount);
		editor.setDecorations(
			deco,
			validLines.map((line) => new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length)),
		);
	}
	const c = counts(ranges);
	if (vscode.window.activeTextEditor === editor && (c.human + c.agent > 0 || hasEvents)) {
		st.statusItem.text = `✍️ ${c.human} · 🤖 ${c.agent}`;
		st.statusItem.tooltip = "coedit: human vs agent lines in this file (click for repo summary)";
		st.statusItem.command = "coedit.showRepoSummary";
		st.statusItem.show();
	} else {
		st.statusItem.hide();
	}
}

// ---------------------------------------------------------------- sensors

function onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
	const st = stateForDoc(event.document);
	if (!st || !st.coedit) return;
	const file = relFile(st, event.document.uri);
	if (!file) return;
	const reason = (event as unknown as { reason?: number }).reason;
	if (reason === 1 || reason === 2) return; // Undo / Redo — not fresh human typing
	if (Date.now() - lastRevertAt < 500 && event.document.uri.fsPath === lastRevertUri?.fsPath) return; // our own revert

	const unsaved = st.unsaved.get(file) ?? new Set<number>();
	for (const change of event.contentChanges) {
		const removed = change.range.end.line - change.range.start.line;
		const added = change.text.split("\n").length - 1;
		const delta = added - removed;
		const shifted = new Set<number>([change.range.start.line]);
		for (const l of unsaved) {
			if (l > change.range.start.line) shifted.add(Math.max(0, l + delta));
			else shifted.add(l);
		}
		unsaved.clear();
		for (const l of shifted) unsaved.add(l);
	}
	st.unsaved.set(file, unsaved);
	rerenderAll(); // unsaved overlay shows immediately
}

function clearUnsaved(doc: vscode.TextDocument): void {
	const st = stateForDoc(doc);
	const file = st ? relFile(st, doc.uri) : null;
	if (st && file) st.unsaved.delete(file);
}

async function onDidSave(doc: vscode.TextDocument): Promise<void> {
	const st = stateForDoc(doc);
	if (!st || !st.coedit) return;
	const file = relFile(st, doc.uri);
	if (!file) return;
	const content = doc.getText();
	const before = st.lastSaved.get(file);
	st.lastSaved.set(file, content);
	st.unsaved.delete(file);
	if (before === undefined || before === content) return;
	const coedit = st.coedit;
	await coedit.ensureFileState(file);
	await coedit.recordEvent(
		{
			file,
			author: "human",
			source: "editor",
			beforeHash: contentHash(before),
			afterHash: contentHash(content),
			hunks: computeHunks(splitLines(before), splitLines(content)),
		},
		{ before, after: content },
	);
	rerenderAll();
}

// ---------------------------------------------------------------- hover

function provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
	const st = stateForDoc(document);
	const file = st ? relFile(st, document.uri) : null;
	if (!st?.coedit || !file) return null;
	const info = hoverInfo(st.coedit, file, position.line);
	return info ? new vscode.Hover(info) : null;
}

function hoverInfo(coedit: Coedit, file: string, line: number): vscode.MarkdownString | null {
	const attr = coedit.engine.get(file);
	const lineInfo = attr?.lines[line];
	if (!lineInfo || (lineInfo.origin !== "agent" && lineInfo.origin !== "both")) return null;
	const events = coedit.store.events({ worktree: coedit.worktree, file });
	const byId = new Map(events.map((e) => [e.id, e]));
	for (let k = lineInfo.events.length - 1; k >= 0; k--) {
		const ev = byId.get(lineInfo.events[k]);
		if (!ev?.agent) continue;
		const md = new vscode.MarkdownString();
		md.appendMarkdown(
			[
				`**🟪 agent line** (${lineInfo.origin})`,
				`- session: \`${ev.agent.sessionId.slice(0, 12)}\``,
				`- turn: ${ev.agent.turn ?? "?"}${ev.agent.model ? ` · model: ${ev.agent.model}` : ""}`,
				ev.agent.promptExcerpt ? `- prompt: “${ev.agent.promptExcerpt}”` : "",
				`- time: ${ev.ts}`,
				`- [copy \`pi --session …\`](command:coedit.copySessionCommand?${encodeURIComponent(JSON.stringify([ev.agent.sessionFile ?? ""]))} "copy the pi session command")`,
			]
				.filter(Boolean)
				.join("\n"),
		);
		md.isTrusted = true;
		return md;
	}
	return null;
}

// ---------------------------------------------------------------- commands

function registerCommands(context: vscode.ExtensionContext): void {
	const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	reg("coedit.nextAgentChange", () => jump(1));
	reg("coedit.prevAgentChange", () => jump(-1));
	reg("coedit.toggleColors", () => {
		for (const st of states) st.enabled = !st.enabled;
		rerenderAll();
	});
	reg("coedit.showWhose", async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const st = stateForDoc(editor.document);
		const file = st ? relFile(st, editor.document.uri) : null;
		if (!st?.coedit || !file) return;
		await st.coedit.ensureFileState(file);
		const doc = await vscode.workspace.openTextDocument({ content: whoseRender(st.coedit, file, editor.document.lineCount), language: "markdown" });
		await vscode.window.showTextDocument(doc, { preview: true });
	});
	reg("coedit.showRepoSummary", async () => {
		const st = states.find((s) => s.coedit);
		if (!st?.coedit) {
			vscode.window.showInformationMessage("coedit: no git repo in the workspace");
			return;
		}
		const summary: FileSummary[] = st.coedit.fileSummary();
		const items = summary.map((s) => ({
			label: pathModule.basename(s.file),
			description: `✍️ ${s.human + s.both} · 🤖 ${s.agent + s.both}${s.unknown ? ` · ⬜ ${s.unknown}` : ""}`,
			detail: s.file,
		}));
		const picked = await vscode.window.showQuickPick(items, { placeHolder: "coedit files — human · agent lines" });
		if (picked?.detail) await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(pathModule.join(st.folder.uri.fsPath, picked.detail)));
	});
	reg("coedit.copySessionCommand", async (sessionFile: string) => {
		if (sessionFile) await vscode.env.clipboard.writeText(`pi --session ${sessionFile}`);
		vscode.window.showInformationMessage("copied: pi --session <file>");
	});
	reg("coedit.revertAgentChangesInFile", () => revertAgent(false));
	reg("coedit.revertAgentChangesInSelection", () => revertAgent(true));
}

function jump(direction: 1 | -1): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const st = stateForDoc(editor.document);
	const file = st ? relFile(st, editor.document.uri) : null;
	if (!st?.coedit || !file) return;
	const hasEvents = st.coedit.store.events({ worktree: st.coedit.worktree, file }).length > 0;
	const ranges = mapAttributionToRanges(st.coedit.engine.get(file), editor.document.lineCount, hasEvents);
	const current = editor.selection.active.line;
	const onAgent = ranges.agent.includes(current) || ranges.both.includes(current);
	const target = direction === 1 ? nextAgentLine(ranges, onAgent ? current + 1 : current) : prevAgentLine(ranges, onAgent ? current - 1 : current);
	if (target === null) {
		vscode.window.showInformationMessage("coedit: no agent lines in this file");
		return;
	}
	const pos = new vscode.Position(target, 0);
	editor.selection = new vscode.Selection(pos, pos);
	editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.InCenter);
}

function whoseRender(coedit: Coedit, file: string, lineCount: number): string {
	const attr = coedit.engine.get(file);
	const events = coedit.store.events({ worktree: coedit.worktree, file });
	const byId = new Map(events.map((e) => [e.id, e]));
	const icon: Record<string, string> = { human: "🟦", agent: "🟪", both: "🟧", unknown: "⬜", unchanged: "  " };
	const out = [`# /whose — ${file}`, `baseline: ${attr?.baseline ? attr.baseline.slice(0, 8) : "first-seen"}`, ""];
	for (let i = 0; i < lineCount; i++) {
		const line = attr?.lines[i];
		const origin = line?.origin ?? "unknown";
		let detail = "";
		if ((origin === "agent" || origin === "both") && line) {
			for (let k = line.events.length - 1; k >= 0; k--) {
				const ev = byId.get(line.events[k]);
				if (ev?.agent) {
					detail = ` — ${ev.agent.sessionId.slice(0, 8)} t${ev.agent.turn ?? "?"}${ev.agent.model ? " " + ev.agent.model : ""}`;
					break;
				}
			}
		}
		out.push(`${String(i + 1).padStart(4)} ${icon[origin]} ${origin.padEnd(9)}${detail}`);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------- revert

async function revertAgent(selectionOnly: boolean): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;
	const st = stateForDoc(editor.document);
	const file = st ? relFile(st, editor.document.uri) : null;
	if (!st?.coedit || !file) return;
	const coedit = st.coedit;
	const doc = editor.document;
	const selFrom = selectionOnly ? editor.selection.start.line : 0;
	const selTo = selectionOnly ? editor.selection.end.line : doc.lineCount - 1;

	const agentEvents = coedit.store.events({ worktree: coedit.worktree, file }).filter((e) => e.author === "agent");
	if (agentEvents.length === 0) {
		vscode.window.showInformationMessage("coedit: no recorded agent changes in this file");
		return;
	}
	if (!(await vscode.window.showWarningMessage(`coedit: revert ${agentEvents.length} agent change(s) in ${file}?`, { modal: true }, "Revert"))) return;

	// Content-anchored revert (pure module, unit-tested): locate each agent hunk's
	// inserted lines verbatim, restore what they replaced, report conflicts.
	const events: RevertEvent[] = [];
	for (const ev of agentEvents) {
		const before = ev.beforeHash ? coedit.store.getBlob(ev.beforeHash) : null;
		const after = ev.afterHash ? coedit.store.getBlob(ev.afterHash) : null;
		events.push({
			hunks: ev.hunks,
			beforeLines: before === null ? null : splitLines(before),
			afterLines: after === null ? null : splitLines(after),
		});
	}
	const currentLines = doc.getText().split("\n");
	if (currentLines.length > 0 && currentLines[currentLines.length - 1] === "") currentLines.pop();
	const result = computeAgentRevert(currentLines, events, selectionOnly ? { from: selFrom, to: selTo } : undefined);
	if (!result.changed) {
		vscode.window.showWarningMessage(
			result.conflicts.length > 0
				? `coedit: nothing reverted — ${result.conflicts.length} hunk(s) conflicted: ${result.conflicts[0]}`
				: "coedit: nothing to revert"
		);
		return;
	}
	const hadTrailingNewline = doc.getText().endsWith("\n") || doc.getText() === "";
	const newText = result.lines.length === 0 ? "" : result.lines.join("\n") + (hadTrailingNewline ? "\n" : "");
	lastRevertUri = doc.uri;
	lastRevertAt = Date.now();
	const wsEdit = new vscode.WorkspaceEdit();
	wsEdit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
	const ok = await vscode.workspace.applyEdit(wsEdit);
	if (ok) {
		await doc.save();
		vscode.window.showInformationMessage(
			`coedit: reverted agent changes (whole-file apply)${result.conflicts.length > 0 ? ` — ${result.conflicts.length} hunk(s) conflicted, review the file` : ""}`
		);
	} else {
		vscode.window.showErrorMessage("coedit: revert failed (conflicting changes)");
	}
}

