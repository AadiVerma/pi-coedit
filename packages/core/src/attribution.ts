import type { AttributedLine, CoeditEvent, FileAttribution, FileSummary, Hunk, LineOrigin } from "./types.ts";
import { newId } from "./util.ts";

interface FileState {
	lines: AttributedLine[];
	/** Commit the attribution is relative to; null when the file was first seen untracked. */
	baseline: string | null;
	binary: boolean;
}

function unknownLine(): AttributedLine {
	return { origin: "unknown", events: [] };
}

function originFromAuthor(author: CoeditEvent["author"]): LineOrigin {
	return author; // "agent" | "human" | "unknown" map 1:1
}

/** Combine a replaced line's previous origin with the author of the change. */
function combine(old: AttributedLine | undefined, ev: CoeditEvent): AttributedLine {
	const prevOrigin = old?.origin ?? "unknown";
	const events = old ? [...old.events, ev.id] : [ev.id];
	// The current content was written by ev.author; `both` records dual authorship
	// of the surviving content, `unknown` when the last writer cannot be named.
	let origin: LineOrigin;
	if (ev.author === "unknown") origin = "unknown";
	else if (prevOrigin === "unchanged" || prevOrigin === ev.author || prevOrigin === "unknown") origin = ev.author;
	else origin = "both";
	return { origin, events };
}

function applyHunksToLines(lines: AttributedLine[], hunks: Hunk[], ev: CoeditEvent): void {
	const sorted = [...hunks].sort((a, b) => a.delStart - b.delStart);
	let shift = 0;
	for (const h of sorted) {
		const pos = h.delStart + shift;
		const removed = lines.splice(pos, h.delCount);
		const inserted: AttributedLine[] = [];
		const pairs = Math.min(h.delCount, h.insCount);
		for (let i = 0; i < h.insCount; i++) {
			if (i < pairs) inserted.push(combine(removed[i], ev));
			else inserted.push({ origin: originFromAuthor(ev.author), events: [ev.id] });
		}
		lines.splice(pos, 0, ...inserted);
		shift += h.insCount - h.delCount;
	}
}

/**
 * Forward-carrying per-line attribution. Line origins are updated from event
 * hunks, never recomputed from scratch, so content never needs to be stored.
 * Lines beyond the tracked array (or in files never observed) read as "unknown".
 */
export class AttributionEngine {
	private files = new Map<string, FileState>();

	/** Drop all state (used when the baseline HEAD changes under us). */
	reset(): void {
		this.files.clear();
	}

	/** Drop one file's state (its recorded chain no longer matches the worktree). */
	resetFile(file: string): void {
		this.files.delete(file);
	}

	/** Rebuild state by replaying events in order (store order is append order). */
	replay(events: CoeditEvent[]): void {
		this.files.clear();
		for (const ev of events) this.applyEvent(ev);
	}

	/** Initial state for a file, from its current content vs the baseline diff (startup case). */
	markInitialDirty(file: string, hunks: Hunk[], currentLineCount: number, baseline: string | null): void {
		const lines: AttributedLine[] = new Array(currentLineCount);
		for (let i = 0; i < currentLineCount; i++) lines[i] = { origin: "unchanged", events: [] };
		for (const h of hunks) {
			for (let i = h.insStart; i < h.insStart + h.insCount && i < currentLineCount; i++) {
				lines[i] = unknownLine();
			}
		}
		this.files.set(file, { lines, baseline, binary: false });
	}

	/** First sight of a file: everything counts as the baseline (unchanged). */
	markBaseline(file: string, currentLineCount: number, baseline: string | null): void {
		const lines: AttributedLine[] = new Array(currentLineCount);
		for (let i = 0; i < currentLineCount; i++) lines[i] = { origin: "unchanged", events: [] };
		this.files.set(file, { lines, baseline, binary: false });
	}

	markBinary(file: string): void {
		this.files.set(file, { lines: [], baseline: this.files.get(file)?.baseline ?? null, binary: true });
	}

	applyEvent(ev: CoeditEvent): void {
		if (ev.binary) {
			this.markBinary(ev.file);
			return;
		}
		if (ev.afterHash === null) {
			this.files.delete(ev.file);
			return;
		}
		let st = this.files.get(ev.file);
		if (ev.beforeHash === null) {
			// Created (or recreated): every current line comes from this event.
			const count = ev.hunks.reduce((n, h) => Math.max(n, h.insStart + h.insCount), 0);
			const lines: AttributedLine[] = new Array(count);
			for (let i = 0; i < count; i++) {
				lines[i] = { origin: originFromAuthor(ev.author), events: [ev.id] };
			}
			this.files.set(ev.file, { lines, baseline: st?.baseline ?? null, binary: false });
			return;
		}
		if (!st) {
			// Never observed before, but the file existed: infer a fully-unknown state
			// sized from the hunks; lines past the last hunk read as unknown via originAt().
			const size = ev.hunks.reduce((n, h) => Math.max(n, h.delStart + h.delCount), 0);
			st = { lines: new Array(size).fill(null).map(() => unknownLine()), baseline: null, binary: false };
			this.files.set(ev.file, st);
		}
		applyHunksToLines(st.lines, ev.hunks, ev);
	}

	handleRename(from: string, to: string): void {
		const st = this.files.get(from);
		if (!st) return;
		this.files.delete(from);
		this.files.set(to, st);
	}

	/**
	 * After a commit: `dirtyVsNewHead` is the diff of new HEAD content vs the
	 * current content (hunks in current-content coordinates). Lines that match
	 * the new HEAD become `unchanged`; still-dirty lines keep their origin.
	 */
	resetBaseline(file: string, dirtyVsNewHead: Hunk[]): void {
		const st = this.files.get(file);
		if (!st) return;
		const dirty = new Array<boolean>(st.lines.length).fill(false);
		for (const h of dirtyVsNewHead) {
			for (let i = h.insStart; i < h.insStart + h.insCount && i < dirty.length; i++) dirty[i] = true;
		}
		for (let i = 0; i < st.lines.length; i++) {
			if (!dirty[i]) st.lines[i] = { origin: "unchanged", events: [] };
		}
	}

	get(file: string): FileAttribution | undefined {
		const st = this.files.get(file);
		if (!st) return undefined;
		return { file, baseline: st.baseline, binary: st.binary, lines: st.lines };
	}

	has(file: string): boolean {
		return this.files.has(file);
	}

	filesTracked(): string[] {
		return [...this.files.keys()];
	}

	summary(): FileSummary[] {
		const out: FileSummary[] = [];
		for (const [file, st] of this.files) {
			const s: FileSummary = { file, human: 0, agent: 0, both: 0, unknown: 0 };
			if (st.binary) {
				out.push(s);
				continue;
			}
			for (const l of st.lines) {
				if (l.origin === "human") s.human++;
				else if (l.origin === "agent") s.agent++;
				else if (l.origin === "both") s.both++;
				else if (l.origin === "unknown") s.unknown++;
			}
			if (s.human + s.agent + s.both + s.unknown > 0) out.push(s);
		}
		return out.sort((a, b) => a.file.localeCompare(b.file));
	}
}

/** Helper for tests and tools: a synthetic unknown-author event. */
export function syntheticUnknownEvent(file: string, worktree: string, hunks: Hunk[], beforeHash: string, afterHash: string): CoeditEvent {
	return { id: newId(), ts: new Date().toISOString(), file, worktree, author: "unknown", source: "fs-watch", beforeHash, afterHash, hunks };
}
