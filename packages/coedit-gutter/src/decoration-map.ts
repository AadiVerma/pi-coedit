/**
 * Pure attribution → decoration mapping. No VS Code imports, fully unit-tested.
 */
import type { FileAttribution, LineOrigin } from "@coedit/core";

export interface DecorationRanges {
	human: number[];
	agent: number[];
	both: number[];
	unknown: number[];
}

export const ORIGINS: LineOrigin[] = ["human", "agent", "both", "unknown"];

export function emptyRanges(): DecorationRanges {
	return { human: [], agent: [], both: [], unknown: [] };
}

/**
 * Map per-line origins to 0-based decoration line numbers. Lines past the
 * attribution array are `unknown` only when the file has events at all
 * (`hasEvents`); untouched files get no decorations.
 */
export function mapAttributionToRanges(attr: FileAttribution | undefined, lineCount: number, hasEvents: boolean): DecorationRanges {
	const ranges = emptyRanges();
	if (!attr) return ranges;
	if (attr.binary) return ranges;
	for (let i = 0; i < lineCount; i++) {
		const origin = i < attr.lines.length ? attr.lines[i].origin : hasEvents ? "unknown" : "unchanged";
		if (origin === "unchanged") continue;
		ranges[origin].push(i);
	}
	return ranges;
}

/**
 * Overlay unsaved human buffer edits: line indexes typed by the editor sensor
 * take precedence over the store's (stale, saved) attribution until save.
 */
export function overlayUnsaved(ranges: DecorationRanges, unsavedHumanLines: Set<number>): DecorationRanges {
	if (unsavedHumanLines.size === 0) return ranges;
	const out: DecorationRanges = {
		human: [...new Set([...ranges.human, ...unsavedHumanLines])].sort((a, b) => a - b),
		agent: ranges.agent.filter((l) => !unsavedHumanLines.has(l)),
		both: ranges.both.filter((l) => !unsavedHumanLines.has(l)),
		unknown: ranges.unknown.filter((l) => !unsavedHumanLines.has(l)),
	};
	return out;
}

/** Next line at or after `from` carrying an agent or both origin (0-based). */
export function nextAgentLine(ranges: DecorationRanges, from: number): number | null {
	const lines = [...ranges.agent, ...ranges.both].sort((a, b) => a - b);
	return lines.find((l) => l >= from) ?? lines[0] ?? null;
}

/** Previous line at or before `from` carrying an agent or both origin (0-based). */
export function prevAgentLine(ranges: DecorationRanges, from: number): number | null {
	const lines = [...ranges.agent, ...ranges.both].sort((a, b) => a - b);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i] <= from) return lines[i];
	}
	return lines.length > 0 ? lines[lines.length - 1] : null;
}

/** Line counts per origin, for the status bar. */
export function counts(ranges: DecorationRanges): { human: number; agent: number } {
	return { human: ranges.human.length, agent: ranges.agent.length + ranges.both.length };
}
