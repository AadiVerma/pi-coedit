/**
 * Pure agent-revert computation (no VS Code imports — fully unit-tested).
 *
 * Given the current document lines and the recorded agent events (newest LAST),
 * compute the document content with the agent's changes undone while leaving
 * human lines untouched. Content-anchored: each hunk's inserted lines are
 * located in the working content by exact match (drift-tolerant), so later human
 * edits to a hunk's context lines and overlapping agent edits are handled.
 * Anything that cannot be located verbatim is reported as a conflict instead of
 * being applied blindly. The caller applies the result as ONE atomic document
 * replacement — no coordinate mapping problems.
 */
import type { Hunk } from "@coedit/core";

export interface RevertEvent {
	hunks: Hunk[];
	/** Content before the agent edit (null = evicted → conflict). */
	beforeLines: string[] | null;
	/** Content after the agent edit. */
	afterLines: string[] | null;
}

export interface RevertResult {
	/** Document content with agent changes undone (caller applies atomically). */
	lines: string[];
	conflicts: string[];
	/** True when at least one hunk was actually reverted. */
	changed: boolean;
	/** Hunks that were outside the requested range and therefore skipped. */
	skipped: number;
}

function stripCr(s: string): string {
	return s.endsWith("\r") ? s.slice(0, -1) : s;
}

function findSequence(haystack: string[], needle: string[], prefer: number): number | null {
	if (needle.length === 0) return null;
	for (let d = 0; d <= haystack.length; d++) {
		for (const start of d === 0 ? [prefer] : [prefer + d, prefer - d]) {
			if (start < 0 || start + needle.length > haystack.length) continue;
			let ok = true;
			for (let i = 0; i < needle.length; i++) {
				if (stripCr(haystack[start + i]) !== stripCr(needle[i])) {
					ok = false;
					break;
				}
			}
			if (ok) return start;
		}
	}
	return null;
}

export function computeAgentRevert(
	lines: string[],
	events: RevertEvent[],
	range?: { from: number; to: number },
): RevertResult {
	const work = [...lines];
	const conflicts: string[] = [];
	let changed = false;
	let skipped = 0;
	// Newest first: undoing the newest edit restores the lines the older edit wrote.
	for (let e = events.length - 1; e >= 0; e--) {
		const ev = events[e];
		if (ev.beforeLines === null || ev.afterLines === null) {
			conflicts.push(`event#${e}: content evicted from the store cache`);
			continue;
		}
		for (const h of [...ev.hunks].sort((a, b) => b.insStart - a.insStart)) {
			const inserted = ev.afterLines.slice(h.insStart, h.insStart + h.insCount);
			const replacement = ev.beforeLines.slice(h.delStart, h.delStart + h.delCount);
			const at = findSequence(work, inserted, h.insStart);
			if (at === null) {
				conflicts.push(`event#${e} hunk@${h.insStart + 1}: inserted lines not found verbatim`);
				continue;
			}
			if (replacement.length === inserted.length && replacement.every((l, i) => stripCr(replacement[i]) === stripCr(work[at + i]))) {
				continue; // already reverted
			}
			if (range && (at > range.to || at + inserted.length - 1 < range.from)) {
				skipped++;
				continue;
			}
			work.splice(at, inserted.length, ...replacement);
			changed = true;
		}
	}
	return { lines: work, conflicts, changed, skipped };
}
