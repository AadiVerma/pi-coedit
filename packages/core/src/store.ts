import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { FileLock } from "./lock.ts";
import type { CoeditConfig, CoeditEvent, CoeditState } from "./types.ts";
import { DEFAULT_CONFIG, SCHEMA_VERSION } from "./types.ts";
import { atomicWrite, contentHash, toPosix } from "./util.ts";

const MAX_BLOBS = 500;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

export interface RecordEventOptions {
	/** Content before the change, when the caller has it. Stored in the blob cache for later diffs. */
	beforeContent?: string | Buffer | null;
	afterContent?: string | Buffer | null;
}

type StoreChangeCb = (change: { kind: "events" | "state" }) => void;

/**
 * The coedit store: `<git-common-dir>/coedit/` — shared across worktrees, never committed.
 * Layout: state.json (schemaVersion + config + cursors), events.jsonl (append-only), lock,
 * blobs/ (content cache keyed by sha256, bounded), backup-<ts>/ (corruption recovery).
 */
export class Store {
	readonly dir: string;
	readonly worktree: string;
	private readonly lock: FileLock;
	private state: CoeditState;
	private watcher: ReturnType<typeof watch> | undefined;
	private changeCbs = new Set<StoreChangeCb>();
	private debounce: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	private constructor(dir: string, worktree: string, state: CoeditState) {
		this.dir = dir;
		this.worktree = worktree;
		this.state = state;
		this.lock = new FileLock(join(dir, "lock"));
	}

	static async open(worktree: string, gitCommonDir: string): Promise<Store> {
		const dir = join(gitCommonDir, "coedit");
		mkdirSync(dir, { recursive: true });
		mkdirSync(join(dir, "blobs"), { recursive: true });
		const state = loadState(dir);
		if (!state.headByWorktree) state.headByWorktree = {};
		if (state.reportedHumanEvents === undefined) state.reportedHumanEvents = [];
		return new Store(dir, worktree, state);
	}

	get config(): CoeditConfig {
		return this.readFreshConfig();
	}

	/**
	 * Config is re-read from disk on access so edits from another session, the
	 * gutter settings UI, or a CLI take effect immediately. Falls back to the
	 * in-memory state when the file is unreadable.
	 */
	private readFreshConfig(): CoeditConfig {
		try {
			const raw = JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8")) as CoeditState;
			if (raw && raw.config) {
				this.state.config = raw.config;
				return raw.config;
			}
		} catch {
			/* fall back to cached */
		}
		return this.state.config;
	}

	getState(): CoeditState {
		return this.state;
	}

	get head(): string | null {
		return this.state.headByWorktree[this.worktree] ?? null;
	}

	async updateConfig(patch: Partial<CoeditConfig>): Promise<void> {
		await this.updateState((s) => {
			Object.assign(s.config, patch);
		});
	}

	async markHead(head: string | null): Promise<void> {
		await this.updateState((s) => {
			s.headByWorktree[this.worktree] = head;
		});
	}

	async markReported(eventId: string): Promise<void> {
		await this.updateState((s) => {
			if (!s.reportedHumanEvents.includes(eventId)) s.reportedHumanEvents.push(eventId);
		});
	}

	async updateState(mutate: (s: CoeditState) => void): Promise<void> {
		await this.lock.with(() => {
			this.state = loadState(this.dir); // pick up concurrent changes
			mutate(this.state);
			atomicWrite(join(this.dir, "state.json"), JSON.stringify(this.state, null, "\t"));
			this.notify("state");
		});
	}

	/** Append one event. Content, when provided, is cached for later diffing (guards, notes, reverts). */
	async recordEvent(event: CoeditEvent, opts: RecordEventOptions = {}): Promise<void> {
		await this.lock.with(() => {
			if (opts.beforeContent !== undefined && opts.beforeContent !== null) {
				this.putBlob(contentHash(opts.beforeContent), opts.beforeContent);
			}
			if (opts.afterContent !== undefined && opts.afterContent !== null) {
				this.putBlob(contentHash(opts.afterContent), opts.afterContent);
			}
			appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(event) + "\n");
			this.notify("events");
		});
	}

	/** All events, newest last. Filterable by worktree and file (posix, repo-root-relative). */
	events(filter: { worktree?: string; file?: string } = {}): CoeditEvent[] {
		const path = join(this.dir, "events.jsonl");
		if (!existsSync(path)) return [];
		const out: CoeditEvent[] = [];
		const raw = readFileSync(path, "utf8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let ev: CoeditEvent;
			try {
				ev = JSON.parse(line) as CoeditEvent;
			} catch {
				continue; // torn final line after a crash
			}
			if (filter.worktree && ev.worktree !== filter.worktree) continue;
			if (filter.file && ev.file !== filter.file) continue;
			out.push(ev);
		}
		return out;
	}

	/** Blob cache lookup by content hash. Returns null when evicted or never stored. */
	getBlob(hash: string): string | null {
		const p = join(this.dir, "blobs", hash);
		try {
			return readFileSync(p, "utf8");
		} catch {
			return null;
		}
	}

	/** Store content in the blob cache without recording an event. Returns its hash. */
	cacheBlob(content: string | Buffer): string {
		const hash = contentHash(content);
		this.putBlob(hash, content);
		return hash;
	}

	private putBlob(hash: string, content: string | Buffer): void {
		if (content.length > MAX_BLOB_BYTES) return;
		const dir = join(this.dir, "blobs");
		const p = join(dir, hash);
		if (existsSync(p)) return;
		try {
			atomicWrite(p, content);
		} catch {
			return;
		}
		// Bound the cache: drop oldest when over budget.
		try {
			const entries = readdirSync(dir)
				.map((name) => {
					const st = statSync(join(dir, name));
					return { name, mtime: st.mtimeMs };
				})
				.sort((a, b) => a.mtime - b.mtime);
			while (entries.length > MAX_BLOBS) {
				const oldest = entries.shift();
				if (oldest) rmSync(join(dir, oldest.name), { force: true });
			}
		} catch {
			/* cache pruning is best-effort */
		}
	}

	/** Watch state.json + events.jsonl; debounced notifications to subscribers. */
	onStoreChange(cb: StoreChangeCb): () => void {
		if (!this.watcher) {
			try {
				this.watcher = watch(this.dir, { persistent: false }, (_event, filename) => {
					if (this.closed) return;
					if (filename && filename.startsWith("backup-")) return;
					if (this.debounce) clearTimeout(this.debounce);
					this.debounce = setTimeout(() => {
						this.debounce = undefined;
						const kind = filename === "state.json" ? "state" : "events";
						for (const cb of this.changeCbs) {
							try {
								cb({ kind });
							} catch {
								/* subscriber errors must not break the watcher */
							}
						}
					}, 50);
				});
			} catch {
				/* store dir not watchable; polling consumers still work */
			}
		}
		this.changeCbs.add(cb);
		return () => this.changeCbs.delete(cb);
	}

	close(): void {
		this.closed = true;
		if (this.debounce) clearTimeout(this.debounce);
		this.watcher?.close();
		this.watcher = undefined;
		this.changeCbs.clear();
	}

	private notify(kind: "events" | "state"): void {
		for (const cb of this.changeCbs) {
			try {
				cb({ kind });
			} catch {
				/* ignore */
			}
		}
	}
}

function loadState(dir: string): CoeditState {
	const path = join(dir, "state.json");
	if (existsSync(path)) {
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as CoeditState;
			return migrate(raw);
		} catch {
			// Corrupted: back it up, start fresh, and warn.
			const backup = join(dir, `backup-${Date.now()}`);
			try {
				rmSync(backup, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			try {
				renameDir(path, backup);
				console.warn(`coedit: corrupted state.json backed up to ${backup}; starting fresh`);
			} catch {
				console.warn("coedit: corrupted state.json could not be backed up; starting fresh");
			}
		}
	}
	const fresh = { schemaVersion: SCHEMA_VERSION, config: { ...DEFAULT_CONFIG }, headByWorktree: {}, reportedHumanEvents: [] };
	// Persist immediately so the store is always observable on disk.
	try {
		atomicWrite(path, JSON.stringify(fresh, null, "\t"));
	} catch {
		/* read-only store: state stays in memory */
	}
	return fresh;
}

function renameDir(file: string, backup: string): void {
	// state.json is a single file; the "backup dir" holds it plus the event log.
	mkdirSafe(backup);
	copyFileSync(file, join(backup, "state.json"));
	const events = join(dirnameOf(file), "events.jsonl");
	if (existsSync(events)) copyFileSync(events, join(backup, "events.jsonl"));
	renameSync(file, `${file}.corrupt`);
}

function mkdirSafe(p: string): void {
	try {
		mkdirSync(p, { recursive: true });
	} catch {
		/* ignore */
	}
}

function dirnameOf(p: string): string {
	return p.slice(0, Math.max(p.lastIndexOf("/"), 0));
}

/** Migrate state.json across schema versions. Currently only v1 exists. */
function migrate(raw: CoeditState): CoeditState {
	if (raw.schemaVersion === SCHEMA_VERSION) return raw;
	// Future migrations go here.
	return { ...raw, schemaVersion: SCHEMA_VERSION };
}

export { toPosix };
