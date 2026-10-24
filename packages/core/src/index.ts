import { AttributionEngine } from "./attribution.ts";

import { computeHunks, formatHunks } from "./diff.ts";
import { attachNote, committerIdentity, dirtyVsHead, gitAiPresent, headCommit, headContent, isGitIgnored, isRepo, readNote, repoInfo } from "./git.ts";
import { GIT_AI_NOTES_REF, buildGitAiNote, renderGitAiNote } from "./gitai.ts";
import { diffSnapshots, emptySnapshot, readContent, takeSnapshot } from "./snapshot.ts";
import { Store } from "./store.ts";
import type { CoeditConfig, CoeditEvent, FileAttribution, FileSummary, Snapshot, SnapshotDiff } from "./types.ts";
import { newId, splitLines, contentHash } from "./util.ts";

export * from "./types.ts";
export { AttributionEngine } from "./attribution.ts";
export { classifyChange } from "./detect.ts";
export { computeHunks, formatHunks } from "./diff.ts";
export { Store } from "./store.ts";
export { FileLock } from "./lock.ts";
export * from "./git.ts";
export { buildGitAiNote, gitAiHumanKey, gitAiSessionId, gitAiTraceId, parseGitAiNote, renderGitAiNote, GIT_AI_NOTES_REF } from "./gitai.ts";
export { diffSnapshots, emptySnapshot, readFileStat, readContent, takeSnapshot } from "./snapshot.ts";
export { contentHash, excerpt, newId, splitLines } from "./util.ts";
export { isBinary } from "./util.ts";

/**
 * The public facade. Open once per session:
 *   const coedit = await Coedit.open(cwd);
 *   await coedit.track();           // baseline + replay of past events
 *   await coedit.recordEvent(...);
 */
export class Coedit {
	readonly store: Store;
	readonly engine = new AttributionEngine();
	readonly worktree: string;
	private lastSnapshot: Snapshot | undefined;
	private headSha: string | null;
	private seeding = new Map<string, Promise<void>>();

	private constructor(store: Store, worktree: string, head: string | null) {
		this.store = store;
		this.worktree = worktree;
		this.headSha = head;
	}

	static async open(cwd: string, opts?: { storeDir?: string }): Promise<Coedit | null> {
		if (!isRepo(cwd)) return null;
		const info = await repoInfo(cwd);
		const store = await Store.open(info.toplevel, opts?.storeDir ?? info.gitCommonDir);
		const head = await headCommit(info.toplevel);
		return new Coedit(store, info.toplevel, head);
	}

	get head(): string | null {
		return this.headSha;
	}

	get config(): CoeditConfig {
		return this.store.config;
	}

	/**
	 * Re-baseline after the worktree's HEAD moved (checkout/reset/pull). Files whose
	 * recorded event chain still matches the worktree keep their attribution; every
	 * other tracked file is re-seeded against the NEW head (dirty lines -> unknown).
	 */
	async resync(): Promise<void> {
		this.headSha = await headCommit(this.worktree);
		for (const file of this.engine.filesTracked()) {
			const cur = readContent(this.worktree, file);
			const events = this.store.events({ worktree: this.worktree, file });
			const chainEnd = events[events.length - 1]?.afterHash ?? null;
			const stillCurrent = cur !== null && chainEnd !== null && chainEnd === contentHash(cur);
			if (!stillCurrent) this.engine.resetFile(file);
		}
		const dirty = await dirtyVsHead(this.worktree);
		for (const file of dirty) {
			if (!this.engine.has(file)) await this.seedFileState(file);
		}
	}

	/** Initial baseline: replay past events, seed never-observed files from HEAD. */
	async track(): Promise<Snapshot> {
		const events = this.store.events({ worktree: this.worktree });
		// Seed per-file baselines so replay starts from real content shapes.
		const byFile = new Map<string, CoeditEvent[]>();
		for (const ev of events) {
			const list = byFile.get(ev.file) ?? [];
			list.push(ev);
			byFile.set(ev.file, list);
		}
		for (const [file, evs] of byFile) {
			const first = evs[0];
			if (first.beforeHash === null) continue; // created by the first event; nothing to seed
			const base = this.store.getBlob(first.beforeHash) ?? (this.headSha ? await headContent(this.worktree, file) : null);
			if (base !== null) this.engine.markBaseline(file, splitLines(base.toString("utf8")).length, this.headSha);
		}
		this.engine.replay(events);
		// Files already dirty vs HEAD with no events: their changes were never observed.
		const dirty = await dirtyVsHead(this.worktree);
		for (const file of dirty) {
			if (this.engine.has(file) || byFile.has(file)) continue;
			await this.seedFileState(file);
		}
		this.lastSnapshot = await takeSnapshot(this.worktree);
		this.headSha = this.lastSnapshot.head;
		return this.lastSnapshot;
	}

	/** Seed a file's line map: dirty lines vs HEAD become `unknown`, the rest `unchanged`. */
	private async seedFileState(file: string): Promise<void> {
		const inflight = this.seeding.get(file);
		if (inflight) return inflight;
		const p = (async () => {
			const head = this.headSha ? await headContent(this.worktree, file) : null;
			const cur = readContent(this.worktree, file);
			const curLines = cur === null ? [] : splitLines(cur);
			if (head === null) {
				// Untracked (or new): first-seen content is the baseline.
				if (cur !== null) this.engine.markBaseline(file, curLines.length, null);
				return;
			}
			const headLines = splitLines(head.toString("utf8"));
			const hunks = computeHunks(headLines, curLines);
			this.engine.markInitialDirty(file, hunks, curLines.length, this.headSha);
		})();
		this.seeding.set(file, p);
		try {
			await p;
		} finally {
			this.seeding.delete(file);
		}
	}

	/**
	 * Give a not-yet-tracked file a baseline derived from its pre-change content,
	 * so the upcoming event applies to real line origins instead of inferred unknowns.
	 */
	private async seedBeforeEvent(file: string, beforeHash: string): Promise<void> {
		if (this.engine.has(file)) return;
		const base = this.store.getBlob(beforeHash) ?? (this.headSha ? await headContent(this.worktree, file) : null);
		if (base !== null) this.engine.markBaseline(file, splitLines(base.toString("utf8")).length, this.headSha);
	}

	async ensureFileState(file: string): Promise<void> {
		if (this.engine.has(file)) return;
		await this.seedFileState(file);
	}

	async snapshot(prev?: Snapshot): Promise<Snapshot> {
		const snap = await takeSnapshot(this.worktree, prev ?? this.lastSnapshot);
		this.lastSnapshot = snap;
		this.headSha = snap.head;
		return snap;
	}

	diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
		return diffSnapshots(before, after);
	}

	emptySnapshot(): Snapshot {
		return emptySnapshot(this.worktree);
	}

	/** Append an event and fold it into the live attribution. */
	async recordEvent(
		event: Omit<CoeditEvent, "id" | "ts" | "worktree"> & Partial<Pick<CoeditEvent, "id" | "ts" | "worktree">>,
		contents?: { before?: string | Buffer | null; after?: string | Buffer | null },
	): Promise<CoeditEvent> {
		const full: CoeditEvent = {
			id: event.id ?? newId(),
			ts: event.ts ?? new Date().toISOString(),
			worktree: event.worktree ?? this.worktree,
			file: event.file,
			author: event.author,
			source: event.source,
			beforeHash: event.beforeHash,
			afterHash: event.afterHash,
			binary: event.binary,
			hunks: event.hunks,
			agent: event.agent,
		};
		await this.store.recordEvent(full, { beforeContent: contents?.before, afterContent: contents?.after });
		if (full.worktree === this.worktree) {
			if (full.beforeHash !== null) await this.seedBeforeEvent(full.file, full.beforeHash);
			this.engine.applyEvent(full);
		}
		return full;
	}

	/** Carry attribution across renames detected at snapshot-diff level. */
	applySnapshotDiff(diff: SnapshotDiff): void {
		for (const [from, to] of diff.renamed) this.engine.handleRename(from, to);
	}

	/** Per-line attribution for a file (seeds state from HEAD on first call). */
	async attribution(file: string): Promise<FileAttribution | undefined> {
		await this.ensureFileState(file);
		return this.engine.get(file);
	}

	fileSummary(): FileSummary[] {
		return this.engine.summary();
	}

	/**
	 * Live view: only lines that currently DIVERGE from HEAD are counted.
	 * A file whose content equals HEAD (committed, or manually reverted)
	 * contributes nothing; in partially-dirty files only the dirty lines do.
	 */
	async fileSummaryLive(): Promise<FileSummary[]> {
		const out: FileSummary[] = [];
		for (const file of this.engine.filesTracked()) {
			const attr = this.engine.get(file);
			if (!attr || attr.binary) continue;
			if (await isGitIgnored(this.worktree, file)) continue; // build artifacts etc. never count
			const cur = readContent(this.worktree, file);
			if (cur === null) continue;
			const curLines = splitLines(cur);
			const dirty: boolean[] = new Array(curLines.length).fill(false);
			const head = this.headSha ? await headContent(this.worktree, file) : null;
			if (head === null) {
				// untracked / new file: every attributed line is uncommitted work
				dirty.fill(true);
			} else {
				const hunks = computeHunks(splitLines(head.toString("utf8")), curLines);
				for (const h of hunks) {
					for (let i = h.insStart; i < h.insStart + h.insCount && i < dirty.length; i++) dirty[i] = true;
				}
			}
			const sum: FileSummary = { file, human: 0, agent: 0, both: 0, unknown: 0 };
			attr.lines.forEach((l, i) => {
				if (i < dirty.length && dirty[i] && l.origin !== "unchanged") sum[l.origin]++;
			});
			if (sum.human + sum.agent + sum.both + sum.unknown > 0) out.push(sum);
		}
		return out.sort((a, b) => a.file.localeCompare(b.file));
	}

	/** Cache content for later diffing (e.g. the overwrite guard's last-read hash). Returns its hash. */
	cacheContent(content: string): string {
		return this.store.cacheBlob(content);
	}

	/**
	 * Changes to `file` since the content with `hash` was last seen.
	 * Uses the blob cache; falls back to a boolean when content was evicted.
	 */
	async humanChangesSince(
		file: string,
		hash: string,
	): Promise<{ changed: boolean; hunks: ReturnType<typeof computeHunks>; diffText: string } | null> {
		const cur = readContent(this.worktree, file);
		if (cur === null) return null;
		if (contentHash(cur) === hash) return { changed: false, hunks: [], diffText: "" };
		// Hash differs → the content the caller saw is gone, whatever the line diff says
		// (a trailing-newline-only change has zero hunks but is still stale).
		const base = this.store.getBlob(hash);
		if (base === null) return { changed: true, hunks: [], diffText: "" };
		const hunks = computeHunks(splitLines(base), splitLines(cur));
		return { changed: true, hunks, diffText: formatHunks(splitLines(base), splitLines(cur), hunks) };
	}

	onStoreChange(cb: Parameters<Store["onStoreChange"]>[0]): () => void {
		return this.store.onStoreChange(cb);
	}

	/**
	 * Baseline reset after a commit: lines that now match the new HEAD become
	 * `unchanged`; returns the attribution snapshot for the note writer.
	 */
	async resetBaseline(newHead: string): Promise<FileAttribution[]> {
		const notes: FileAttribution[] = [];
		const dirty = await dirtyVsHead(this.worktree);
		for (const file of this.engine.filesTracked()) {
			const attr = this.engine.get(file);
			if (!attr || attr.binary) continue;
			const cur = readContent(this.worktree, file);
			if (cur === null) continue;
			const head = await headContent(this.worktree, file);
			if (head === null) continue; // not part of this commit
			const hunks = dirty.has(file) ? computeHunks(splitLines(head.toString("utf8")), splitLines(cur)) : [];
			this.engine.resetBaseline(file, hunks);
			const after = this.engine.get(file);
			if (after) notes.push(after);
		}
		this.headSha = newHead;
		await this.store.markHead(newHead);
		return notes;
	}

	/** Build (and, when policy allows, attach) a Git AI–standard authorship log for `commit`. */
	async exportGitAiNote(commit: string, opts?: { attach?: boolean }): Promise<string> {
		const attributions = this.engine
			.filesTracked()
			.map((f) => this.engine.get(f))
			.filter((a): a is FileAttribution => a !== undefined);
		const events = this.store.events({ worktree: this.worktree });
		const identity = await committerIdentity(this.worktree);
		const note = buildGitAiNote(commit, attributions, events, { humanIdentity: identity });
		const text = renderGitAiNote(note);
		const gitai = await gitAiPresent();
		const attach = opts?.attach ?? (gitai === null && this.store.config.gitaiAttachNotes);
		if (attach) {
			try {
				await attachNote(this.worktree, GIT_AI_NOTES_REF, commit, text);
			} catch (e) {
				console.warn(`coedit: could not attach Git AI note: ${(e as Error).message}`);
			}
		}
		return text;
	}

	/** Read-only view of an existing Git AI note (when git-ai is installed). */
	async readGitAiNote(commit: string): Promise<string | null> {
		return readNote(this.worktree, GIT_AI_NOTES_REF, commit);
	}

	close(): void {
		this.store.close();
	}
}
