import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitError extends Error {
	readonly args: string[];

	constructor(message: string, args: string[]) {
		super(message);
		this.args = args;
	}
}

async function git(cwd: string, args: string[], encoding: "utf8" | "binary" = "utf8"): Promise<string> {
	try {
		const { stdout } = await exec("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding });
		return stdout as unknown as string;
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		throw new GitError(err.stderr?.trim() || err.message || "git failed", args);
	}
}

export function isRepo(cwd: string): boolean {
	const r = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "ignore" });
	return r.status === 0;
}

export interface RepoInfo {
	/** Absolute worktree root (top-level of this worktree). */
	toplevel: string;
	/** Absolute git common dir — shared across worktrees; the coedit store lives here. */
	gitCommonDir: string;
}

export async function repoInfo(cwd: string): Promise<RepoInfo> {
	const out = await git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
	const [toplevel, commonDir] = out.trim().split("\n");
	const abs = (p: string) => (p.startsWith("/") ? p : join(cwd, p));
	return { toplevel: abs(toplevel), gitCommonDir: abs(commonDir) };
}

export async function headCommit(cwd: string): Promise<string | null> {
	try {
		const out = await git(cwd, ["rev-parse", "HEAD"]);
		return out.trim() || null;
	} catch {
		return null;
	}
}

export async function headContent(cwd: string, file: string): Promise<Buffer | null> {
	try {
		return Buffer.from(await git(cwd, ["cat-file", "blob", `HEAD:${file}`], "binary"), "binary");
	} catch {
		return null;
	}
}

/** Every git-tracked plus untracked-but-not-ignored file, NUL separated. */
export async function listWorkFiles(cwd: string): Promise<string[]> {
	const out = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], "binary");
	// "binary" (latin1) keeps bytes 1:1; re-decode as UTF-8 so unicode paths survive.
	return Buffer.from(out, "latin1")
		.toString("utf8")
		.split("\0")
		.filter((p) => p.length > 0);
}

/** Tracked files that differ from HEAD (staged or unstaged). Untracked files are not listed. */
export async function dirtyVsHead(cwd: string): Promise<Set<string>> {
	try {
		const out = await git(cwd, ["diff", "--name-only", "-z", "HEAD"], "binary");
		return new Set(
			Buffer.from(out, "latin1")
				.toString("utf8")
				.split("\0")
				.filter((p) => p.length > 0),
		);
	} catch {
		return new Set();
	}
}

export async function committerIdentity(cwd: string): Promise<string> {
	let name = "";
	let email = "";
	try {
		name = (await git(cwd, ["config", "user.name"])).trim();
	} catch {
		/* unset */
	}
	try {
		email = (await git(cwd, ["config", "user.email"])).trim();
	} catch {
		/* unset */
	}
	return `${name || "Unknown"} <${email || "unknown@localhost"}>`;
}

export async function gitAiPresent(): Promise<string | null> {
	try {
		const { stdout } = await exec("git-ai", ["--version"], { timeout: 5_000 });
		return stdout.trim();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Notes

export async function readNote(cwd: string, ref: string, commit: string): Promise<string | null> {
	try {
		return await git(cwd, ["notes", `--ref=${ref}`, "show", commit]);
	} catch {
		return null;
	}
}

export async function attachNote(cwd: string, ref: string, commit: string, message: string): Promise<void> {
	const tmp = mkdtempSync(join(tmpdir(), "coedit-note-"));
	const file = join(tmp, "note.txt");
	const { writeFileSync } = await import("node:fs");
	writeFileSync(file, message);
	await git(cwd, ["notes", `--ref=${ref}`, "add", "-f", "-F", file, commit]);
}

// ---------------------------------------------------------------------------
// Plumbing (shadow history for pi-bisect)

/** Stage the whole worktree into a temporary index and return its tree sha. */
export async function writeTreeFromWorktree(cwd: string): Promise<string> {
	const indexFile = join(mkdtempSync(join(tmpdir(), "coedit-idx-")), "index");
	const env = { ...process.env, GIT_INDEX_FILE: indexFile };
	try {
		await exec("git", ["add", "-A", "--"], { cwd, env, maxBuffer: 256 * 1024 * 1024 });
		const { stdout } = await exec("git", ["write-tree"], { cwd, env });
		return stdout.trim();
	} finally {
		/* temp dir cleanup is best-effort; contents are tiny */
	}
}

export async function commitTree(cwd: string, tree: string, parents: string[], message: string): Promise<string> {
	const args = ["commit-tree", tree];
	for (const p of parents) args.push("-p", p);
	args.push("-m", message);
	const { stdout } = await exec("git", args, { cwd, maxBuffer: 1024 * 1024 });
	return stdout.trim();
}

export async function updateRef(cwd: string, ref: string, sha: string): Promise<void> {
	await git(cwd, ["update-ref", ref, sha]);
}

export async function readRef(cwd: string, ref: string): Promise<string | null> {
	try {
		return (await git(cwd, ["rev-parse", "--verify", "-q", ref])).trim() || null;
	} catch {
		return null;
	}
}

export async function revList(cwd: string, ref: string): Promise<string[]> {
	try {
		const out = await git(cwd, ["rev-list", ref]);
		return out.trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/** List refs matching a prefix, e.g. refs/coedit/edits/. */
export async function listRefs(cwd: string, prefix: string): Promise<Map<string, string>> {
	const out = await git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
	const map = new Map<string, string>();
	for (const line of out.trim().split("\n")) {
		if (!line) continue;
		const [ref, sha] = line.split(" ");
		map.set(ref, sha);
	}
	return map;
}

export async function worktreeAdd(cwd: string, dir: string, commit: string): Promise<void> {
	await git(cwd, ["worktree", "add", "--detach", "--quiet", dir, commit]);
}

export async function worktreeRemove(cwd: string, dir: string): Promise<void> {
	try {
		await git(cwd, ["worktree", "remove", "--force", dir]);
	} catch {
		try {
			await git(cwd, ["worktree", "prune"]);
		} catch {
			/* nothing to prune */
		}
	}
}

export async function commitMessage(cwd: string, sha: string): Promise<string> {
	return (await git(cwd, ["log", "-1", "--format=%B", sha])).trim();
}

export async function applyPatch(
	cwd: string,
	patch: string,
): Promise<{ applied: boolean; mode: "plain" | "3way" | null }> {
	const tmp = mkdtempSync(join(tmpdir(), "coedit-patch-"));
	const file = join(tmp, "patch.diff");
	const { writeFileSync } = await import("node:fs");
	writeFileSync(file, patch);
	try {
		await git(cwd, ["apply", file]);
		return { applied: true, mode: "plain" };
	} catch {
		/* fall through to 3-way */
	}
	try {
		await git(cwd, ["apply", "-3", file]);
		return { applied: true, mode: "3way" };
	} catch {
		return { applied: false, mode: null };
	}
}
