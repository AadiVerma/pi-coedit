/** Who made a change. `unknown` means human-vs-agent could not be determined — never guessed. */
export type Author = "agent" | "human" | "unknown";

/** How the change was observed. */
export type EventSource = "pi-edit" | "pi-write" | "pi-bash" | "editor" | "fs-watch";

/** Agent-side metadata recorded on every agent event. pi-bisect and pi-ledger depend on it. */
export interface AgentMeta {
	sessionId: string;
	sessionFile?: string;
	entryId?: string;
	turn?: number;
	toolCallId?: string;
	model?: string;
	/** First N chars of the user prompt for that turn. Capped, switchable off via privacy.promptExcerpts. */
	promptExcerpt?: string;
}

/**
 * A changed line range. Line numbers are 0-based; delStart/delCount index the
 * content before the change, insStart/insCount the content after it.
 */
export interface Hunk {
	delStart: number;
	delCount: number;
	insStart: number;
	insCount: number;
}

/** One append-only record of a file change. */
export interface CoeditEvent {
	id: string;
	ts: string;
	/** Repo-root-relative path with posix separators. */
	file: string;
	/** Absolute path of the worktree the change belongs to (the store is shared across worktrees). */
	worktree: string;
	author: Author;
	source: EventSource;
	/** sha256 of the content before the change; null when the file did not exist. */
	beforeHash: string | null;
	/** sha256 of the content after the change; null when the file was deleted. */
	afterHash: string | null;
	binary?: boolean;
	hunks: Hunk[];
	agent?: AgentMeta;
}

/** Origin of a current line, relative to the baseline (HEAD, or first-seen for untracked files). */
export type LineOrigin = "unchanged" | "human" | "agent" | "both" | "unknown";

export interface AttributedLine {
	origin: LineOrigin;
	/** Ids of the events that touched this line's content lineage, in order. */
	events: string[];
}

export interface FileAttribution {
	file: string;
	/** Commit the attribution is relative to; null when the file was first seen untracked. */
	baseline: string | null;
	binary?: boolean;
	/** One entry per line of the current file content. */
	lines: AttributedLine[];
}

export interface FileStat {
	hash: string;
	mtimeMs: number;
	size: number;
	binary: boolean;
}

export interface Snapshot {
	worktree: string;
	ts: string;
	/** HEAD commit at snapshot time, null when the repo has no commits. */
	head: string | null;
	/** path -> stat for every git-tracked plus untracked-not-ignored file. */
	files: Map<string, FileStat>;
}

export interface SnapshotDiff {
	added: string[];
	removed: string[];
	changed: string[];
	/** [from, to] pairs where content hash matches — treated as renames. */
	renamed: Array<[string, string]>;
}

export interface CoeditConfig {
	/** Policy for the overwrite guard. */
	overwriteGuard: "block" | "ask" | "warn" | "off";
	/** Attach Git AI–standard notes on baseline reset (only honoured when the git-ai binary is absent). */
	gitaiAttachNotes: boolean;
	/** Include capped prompt excerpts in events, hovers and notes. */
	promptExcerpts: boolean;
	/** Max chars of a human diff injected into model context per note. */
	maxHumanDiffChars: number;
}

export const DEFAULT_CONFIG: CoeditConfig = {
	overwriteGuard: "ask",
	gitaiAttachNotes: true,
	promptExcerpts: true,
	maxHumanDiffChars: 2000,
};

export interface CoeditState {
	schemaVersion: number;
	config: CoeditConfig;
	/** HEAD at the last baseline reset, per worktree. */
	headByWorktree: Record<string, string | null>;
	/** Event ids already reported to the model as human-edit notes (once per change). */
	reportedHumanEvents: string[];
}

export const SCHEMA_VERSION = 1;

export interface FileSummary {
	file: string;
	human: number;
	agent: number;
	both: number;
	unknown: number;
}
