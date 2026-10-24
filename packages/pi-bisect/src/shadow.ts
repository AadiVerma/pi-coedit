/**
 * Shadow history: one plumbing commit per agent change, stored under
 * `refs/coedit/edits/<sessionId>`. Never touches the user's index, HEAD,
 * branches or stash. Metadata lives in a sidecar inside the coedit store.
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitTree, readRef, updateRef, writeTreeFromWorktree } from "@coedit/core";

export interface ShadowMeta {
	sha: string;
	ts: string;
	turn: number;
	toolCallId: string;
	tool: string;
	files: string[];
	model?: string;
	promptExcerpt?: string;
	sessionFile?: string;
}

export class ShadowHistory {
	readonly worktree: string;
	readonly storeDir: string;
	readonly sessionId: string;
	private lastTree: string | null = null;

	constructor(worktree: string, storeDir: string, sessionId: string) {
		this.worktree = worktree;
		this.storeDir = storeDir;
		this.sessionId = sessionId;
	}

	private get ref(): string {
		return `refs/coedit/edits/${this.sessionId}`;
	}

	private get sidecar(): string {
		return join(this.storeDir, "shadow", `${this.sessionId}.jsonl`);
	}

	/**
	 * Snapshot the whole worktree (tracked + untracked-not-ignored) as one commit.
	 * No-ops when the tree is unchanged since the last shadow commit.
	 */
	async record(meta: Omit<ShadowMeta, "sha" | "ts">): Promise<string | null> {
		const tree = await writeTreeFromWorktree(this.worktree);
		if (tree === this.lastTree) return null;
		const parent = await readRef(this.worktree, this.ref);
		const message = `coedit shadow: t${meta.turn} ${meta.tool} ${meta.files.join(",")}`.slice(0, 200);
		const sha = await commitTree(this.worktree, tree, parent ? [parent] : [], message);
		await updateRef(this.worktree, this.ref, sha);
		this.lastTree = tree;
		const entry: ShadowMeta = { ...meta, sha, ts: new Date().toISOString() };
		mkdirSync(join(this.storeDir, "shadow"), { recursive: true });
		appendFileSync(this.sidecar, JSON.stringify(entry) + "\n");
		return sha;
	}

	/** Oldest..newest shadow commits with their metadata (newest last). */
	async history(): Promise<ShadowMeta[]> {
		const file = this.sidecar;
		if (!existsSync(file)) return [];
		const out: ShadowMeta[] = [];
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as ShadowMeta);
			} catch {
				/* torn tail */
			}
		}
		return out;
	}
}
