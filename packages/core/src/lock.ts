import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { sleep } from "./util.ts";

interface LockContents {
	pid: number;
	ts: number;
	host: string;
}

function pidAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Cross-process advisory lock file with stale recovery.
 * A lock is stale when its pid is dead or older than `staleMs`.
 */
export class FileLock {
	readonly path: string;
	private readonly staleMs: number;

	constructor(path: string, staleMs = 30_000) {
		this.path = path;
		this.staleMs = staleMs;
	}

	private tryAcquire(): LockContents | null {
		let fd: number;
		try {
			fd = openSync(this.path, "wx");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
			throw e;
		}
		const mine: LockContents = { pid: process.pid, ts: Date.now(), host: process.platform };
		try {
			writeSync(fd, JSON.stringify(mine));
		} finally {
			closeSync(fd);
		}
		return mine;
	}

	private readHolder(): LockContents | null {
		try {
			return JSON.parse(readFileSync(this.path, "utf8")) as LockContents;
		} catch {
			return null;
		}
	}

	private breakIfStale(holder: LockContents): boolean {
		const stale = Date.now() - holder.ts > this.staleMs || !pidAlive(holder.pid);
		if (!stale) return false;
		try {
			unlinkSync(this.path);
		} catch {
			/* someone else broke it first */
		}
		return true;
	}

	/** Run `fn` while holding the lock. Throws after `timeoutMs` when the lock stays busy. */
	async with<T>(fn: () => T | Promise<T>, timeoutMs = 5_000): Promise<T> {
		let mine: LockContents | null = null;
		const deadline = Date.now() + timeoutMs;
		while (mine === null) {
			mine = this.tryAcquire();
			if (mine) break;
			const holder = this.readHolder();
			if (!holder || this.breakIfStale(holder)) continue; // retry immediately
			if (Date.now() > deadline) {
				throw new Error(
					`coedit: lock busy at ${this.path} (held by pid ${holder.pid} since ${new Date(holder.ts).toISOString()})`,
				);
			}
			await sleep(25);
		}
		try {
			return await fn();
		} finally {
			try {
				const now = this.readHolder();
				if (now && now.pid === process.pid && now.ts === mine.ts) unlinkSync(this.path);
			} catch {
				/* already gone */
			}
		}
	}
}
