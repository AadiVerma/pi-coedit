/**
 * pi-ledger — agent cost per commit.
 *
 * Usage is captured per turn (turn_end carries the assistant message with its
 * usage) and persisted to `<store>/ledger/<sessionId>.jsonl`. On commit, the
 * post-commit hook aggregates the events + usage recorded since the previous
 * commit into a note on refs/notes/pi-ledger. When Git AI notes exist, line
 * attribution links to them instead of being duplicated.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
export const LEDGER_NOTES_REF = "pi-ledger";
export const LEDGER_SCHEMA = "pi-ledger/1";

export interface TurnUsage {
	ts: string;
	turn: number;
	sessionId: string;
	model: string;
	provider?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

export interface LedgerEdit {
	toolCallId: string;
	turn: number;
	tool: string;
	files: string[];
}

export interface LedgerNote {
	schema: typeof LEDGER_SCHEMA;
	commit: string;
	ts: string;
	sessions: Array<{
		sessionId: string;
		sessionFile?: string;
		models: string[];
		tokensIn: number;
		tokensOut: number;
		costUsd: number;
	}>;
	edits: LedgerEdit[];
	/** Line attribution when known (from refs/notes/ai when Git AI wrote it, else null). */
	lines: { agent: number | null; human: number | null; source: "git-ai" | null };
}

// ---------------------------------------------------------------- recording

export function recordTurnUsage(storeDir: string, sessionId: string, usage: TurnUsage): void {
	const dir = join(storeDir, "ledger");
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify(usage) + "\n");
}

export function readLedgerUsage(storeDir: string): TurnUsage[] {
	const dir = join(storeDir, "ledger");
	if (!existsSync(dir)) return [];
	const out: TurnUsage[] = [];
	for (const file of existsSync(dir) ? readdirSync(dir) : []) {
		if (!file.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as TurnUsage);
			} catch {
				/* torn tail */
			}
		}
	}
	return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

// ---------------------------------------------------------------- note building

export function buildLedgerNote(input: {
	commit: string;
	usage: TurnUsage[];
	edits: LedgerEdit[];
	agentLines: number | null;
	humanLines: number | null;
}): LedgerNote {
	const bySession = new Map<string, LedgerNote["sessions"][number]>();
	for (const u of input.usage) {
		let s = bySession.get(u.sessionId);
		if (!s) {
			s = { sessionId: u.sessionId, models: [], tokensIn: 0, tokensOut: 0, costUsd: 0 };
			bySession.set(u.sessionId, s);
		}
		s.tokensIn += u.input;
		s.tokensOut += u.output;
		s.costUsd += u.costUsd;
		if (!s.models.includes(u.model)) s.models.push(u.model);
	}
	return {
		schema: LEDGER_SCHEMA,
		commit: input.commit,
		ts: new Date().toISOString(),
		sessions: [...bySession.values()].map((s) => ({ ...s, costUsd: round4(s.costUsd) })),
		edits: input.edits,
		lines: { agent: input.agentLines, human: input.humanLines, source: input.agentLines !== null ? "git-ai" : null },
	};
}

export function renderLedgerNote(note: LedgerNote): string {
	return JSON.stringify(note, null, 2);
}

export function parseLedgerNote(text: string): LedgerNote {
	return JSON.parse(text) as LedgerNote;
}

// ---------------------------------------------------------------- helpers

/** Aggregate a commit's ledger data: usage + edits since the previous commit. */
export function commitLedger(input: {
	storeDir: string;
	commit: string;
	committedFiles: string[];
	events: Array<{ ts: string; file: string; author: string; source: string; agent?: { sessionId: string; turn?: number; toolCallId?: string; model?: string; sessionFile?: string } }>;
	/** ISO time of the previous commit; usage/events before it are excluded. */
	sinceIso: string | null;
}): LedgerNote {
	const sinceMs = input.sinceIso ? new Date(input.sinceIso).getTime() : null;
	const usage = readLedgerUsage(input.storeDir);
	const relevantUsage = usage.filter((u) => (sinceMs !== null ? new Date(u.ts).getTime() > sinceMs : true));
	const edits: LedgerEdit[] = [];
	const seen = new Set<string>();
	for (const ev of input.events) {
		if (!ev.agent?.toolCallId) continue;
		if (input.committedFiles.length > 0 && !input.committedFiles.includes(ev.file)) continue;
		if (sinceMs !== null && new Date(ev.ts).getTime() <= sinceMs) continue;
		if (seen.has(ev.agent.toolCallId)) continue;
		seen.add(ev.agent.toolCallId);
		edits.push({ toolCallId: ev.agent.toolCallId, turn: ev.agent.turn ?? -1, tool: ev.source, files: [ev.file] });
	}
	return buildLedgerNote({ commit: input.commit, usage: relevantUsage, edits, agentLines: null, humanLines: null });
}

function round4(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------- formatting

export function formatNoteSummary(note: LedgerNote): string {
	const lines: string[] = [];
	lines.push(`commit ${note.commit.slice(0, 10)} — ${note.sessions.length} session(s), ${note.edits.length} agent edit(s)`);
	for (const s of note.sessions) {
		lines.push(
			`  ${s.models.join("+")} · ↑${fmtTokens(s.tokensIn)} ↓${fmtTokens(s.tokensOut)} · $${s.costUsd.toFixed(4)} (${s.sessionId.slice(0, 8)})`,
		);
	}
	if (note.lines.agent !== null) {
		lines.push(`  lines: 🤖 ${note.lines.agent} agent · ✍️ ${note.lines.human ?? "?"} human (via ${note.lines.source})`);
	}
	return lines.join("\n");
}

export function formatRangeTotals(notes: LedgerNote[]): string {
	const totals = { tokensIn: 0, tokensOut: 0, costUsd: 0, edits: 0, sessions: new Set<string>() };
	const byModel = new Map<string, { tokensIn: number; tokensOut: number; costUsd: number }>();
	for (const n of notes) {
		for (const s of n.sessions) {
			totals.tokensIn += s.tokensIn;
			totals.tokensOut += s.tokensOut;
			totals.costUsd += s.costUsd;
			totals.sessions.add(s.sessionId);
			for (const m of s.models) {
				const agg = byModel.get(m) ?? { tokensIn: 0, tokensOut: 0, costUsd: 0 };
				agg.tokensIn += s.tokensIn;
				agg.tokensOut += s.tokensOut;
				agg.costUsd += s.costUsd;
				byModel.set(m, agg);
			}
		}
		totals.edits += n.edits.length;
	}
	const out = [
		`pi-ledger range totals — ${notes.length} commit(s), ${totals.sessions.size} session(s), ${totals.edits} agent edit(s)`,
		`  tokens: ↑${fmtTokens(totals.tokensIn)} ↓${fmtTokens(totals.tokensOut)} · cost: $${totals.costUsd.toFixed(4)}`,
	];
	for (const [model, agg] of [...byModel.entries()].sort((a, b) => b[1].costUsd - a[1].costUsd)) {
		out.push(`  ${model}: ↑${fmtTokens(agg.tokensIn)} ↓${fmtTokens(agg.tokensOut)} · $${agg.costUsd.toFixed(4)}`);
	}
	return out.join("\n");
}

function fmtTokens(n: number): string {
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}
