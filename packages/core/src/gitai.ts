import { createHash, randomBytes } from "node:crypto";
import type { CoeditEvent, FileAttribution } from "./types.ts";

/**
 * Git AI standard v3.0.0 codec (specs/git_ai_standard_v3.0.0.md).
 * coedit only WRITES `refs/notes/ai` when the git-ai binary is absent; when
 * Git AI is installed its daemon owns the ref and we stay read-only.
 * See docs/PLAN.md §0.2 for the interop decision.
 */

export const GIT_AI_SCHEMA_VERSION = "authorship/3.0.0";
export const GIT_AI_NOTES_REF = "ai";

function hash14(input: string, prefix: string): string {
	return prefix + createHash("sha256").update(input).digest("hex").slice(0, 14);
}

/** `s_<14hex>` — deterministic per (tool, conversation id). */
export function gitAiSessionId(sessionId: string, tool = "pi"): string {
	return hash14(`${tool}:${sessionId}`, "s_");
}

/** `t_<14hex>` — random per checkpoint call. */
export function gitAiTraceId(): string {
	return "t_" + randomBytes(7).toString("hex");
}

/** `h_<14hex>` — deterministic per human identity ("Name <email>"). */
export function gitAiHumanKey(identity: string): string {
	return hash14(identity, "h_");
}

export interface GitAiNote {
	/** Per file: attestation key -> sorted line numbers (0-based, converted on export). */
	attestations: Map<string, Map<string, number[]>>;
	metadata: {
		schema_version: string;
		base_commit_sha: string;
		prompts: Record<string, unknown>;
		sessions: Record<string, { agent_id: { tool: string; id: string; model: string }; human_author?: string }>;
		humans: Record<string, { author: string }>;
	};
}

/**
 * Build a standard-compliant authorship log from current attribution.
 * Agent lines use the last agent event that touched the line; human lines the
 * committer identity; unknown/both lines are attested for neither (they stay
 * "untracked" in Git AI terms — honest, since authorship is unclear).
 */
export function buildGitAiNote(
	commit: string,
	attributions: FileAttribution[],
	events: CoeditEvent[],
	opts: { tool?: string; humanIdentity: string },
): GitAiNote {
	const byId = new Map(events.map((e) => [e.id, e]));
	const note: GitAiNote = {
		attestations: new Map(),
		metadata: { schema_version: GIT_AI_SCHEMA_VERSION, base_commit_sha: commit, prompts: {}, sessions: {}, humans: {} },
	};
	const tool = opts.tool ?? "pi";
	const trace = gitAiTraceId(); // one trace per checkpoint (= per note)

	const attestFor = (file: string) => {
		let m = note.attestations.get(file);
		if (!m) {
			m = new Map();
			note.attestations.set(file, m);
		}
		return m;
	};

	for (const attr of attributions) {
		if (attr.binary) continue;
		const att = attestFor(attr.file);
		attr.lines.forEach((line, idx) => {
			if (line.origin === "agent" || line.origin === "both") {
				// Last agent event wins for this line.
				for (let i = line.events.length - 1; i >= 0; i--) {
					const ev = byId.get(line.events[i]);
					if (ev?.author === "agent" && ev.agent) {
						const sid = gitAiSessionId(ev.agent.sessionId, tool);
						const key = `${sid}::${trace}`;
						if (!note.metadata.sessions[sid]) {
							note.metadata.sessions[sid] = {
								agent_id: { tool, id: ev.agent.sessionId, model: ev.agent.model ?? "unknown" },
							};
						}
						push(att, key, idx);
						return;
					}
				}
			}
			if (line.origin === "human") {
				const hKey = gitAiHumanKey(opts.humanIdentity);
				note.metadata.humans[hKey] = { author: opts.humanIdentity };
				push(att, hKey, idx);
			}
		});
	}
	return note;
}

function push(att: Map<string, number[]>, key: string, line: number): void {
	const arr = att.get(key);
	if (arr) arr.push(line);
	else att.set(key, [line]);
}

function formatRanges(lines: number[]): string {
	const sorted = [...new Set(lines)].sort((a, b) => a - b);
	if (sorted.length === 0) return "";
	// Input is 0-based; the standard wants 1-based inclusive ranges.
	const out: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (let i = 1; i <= sorted.length; i++) {
		const cur = sorted[i];
		if (cur === prev + 1) {
			prev = cur;
			continue;
		}
		out.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
		start = cur;
		prev = cur;
	}
	return out.join(",");
}

export function renderGitAiNote(note: GitAiNote): string {
	const lines: string[] = [];
	for (const [file, att] of note.attestations) {
		if (att.size === 0) continue;
		lines.push(file);
		for (const [key, lineNums] of att) {
			if (lineNums.length === 0) continue;
			lines.push(`  ${key} ${formatRanges(lineNums)}`);
		}
	}
	const metadata: Record<string, unknown> = {
		schema_version: note.metadata.schema_version,
		base_commit_sha: note.metadata.base_commit_sha,
		prompts: note.metadata.prompts,
	};
	if (Object.keys(note.metadata.humans).length > 0) metadata.humans = note.metadata.humans;
	if (Object.keys(note.metadata.sessions).length > 0) metadata.sessions = note.metadata.sessions;
	return `${lines.join("\n")}\n---\n${JSON.stringify(metadata, null, 2)}\n`;
}

/** Parse an existing note back into attestations (read-only interop). */
export function parseGitAiNote(
	note: string,
): { attestations: Array<{ file: string; key: string; ranges: string }>; metadata: Record<string, unknown> } {
	const [attestation, , metadataJson] = note.split("\n---\n");
	const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
	const attestations: Array<{ file: string; key: string; ranges: string }> = [];
	let file = "";
	for (const line of attestation.split("\n")) {
		if (!line.trim()) continue;
		if (!line.startsWith("  ")) {
			file = line.startsWith('"') ? line.slice(1, -1) : line;
		} else {
			const [key, ranges] = line.trim().split(/\s+/);
			attestations.push({ file, key, ranges });
		}
	}
	return { attestations, metadata };
}
