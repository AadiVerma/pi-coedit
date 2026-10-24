import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "coedit-bisect-test-"));
	git(dir, ["init", "-b", "main"]);
	git(dir, ["config", "user.name", "Test Human"]);
	git(dir, ["config", "user.email", "human@example.com"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	return dir;
}

export function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}
