#!/usr/bin/env node
// pi-bisect demo: a real pi session (scripted offline provider) makes 4 edits to
// util.js — the 3rd breaks `node test.js`. After the session, the bisect engine
// runs over the shadow history the session produced, names the culprit, and
// reverts only that edit.
//
//   node scripts/demo/run-bisect-demo.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pi = join(process.env.HOME, ".pi/agent/bin/pi");

const fixture = mkdtempSync(join(tmpdir(), "coedit-bisect-demo-"));
const git = (args, opts = {}) => execFileSync("git", args, { cwd: fixture, encoding: "utf8", ...opts });
git(["init", "-q", "-b", "main"]);
git(["config", "user.name", "Demo Human"]);
git(["config", "user.email", "human@example.com"]);
writeFileSync(join(fixture, "util.js"), "module.exports.add = (a, b) => a + b;\n");
writeFileSync(join(fixture, "test.js"), "const { add } = require('./util.js');\nconsole.assert(add(1, 1) === 2, 'add broken');\nconsole.log('ok');\n");
git(["add", "."]);
git(["commit", "-qm", "init"]);

// The scripted driver's edits land via the real edit tool:
// 1: harmless comment, 2: add subtract10 helper (fine), 3: BREAKS add(), 4: harmless comment.
const driver = join(root, "scripts", "demo", "bisect-driver.ts");

console.log(`[demo] fixture: ${fixture}\n[demo] running real pi session (4 agent edits, #3 breaks the test)...\n`);
await new Promise((resolveSpawn) => {
	const child = spawn(
		pi,
		["--mode", "json", "-e", join(root, "packages", "pi-bisect"), "-e", driver, "--model", "coedit-demo/scripted", "--no-session", "Make a few improvements to util.js."],
		{ cwd: fixture, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let out = "";
	let err = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (err += d));
	child.on("close", (code) => {
		resolveSpawn({ code, out, err });
	});
});

const { readdirSync } = await import("node:fs");
const shadowDir = join(fixture, ".git", "coedit", "shadow");
const sidecarName = readdirSync(shadowDir).find((f) => f.endsWith(".jsonl"));
if (!sidecarName) {
	console.error("[demo] the pi session recorded no shadow history");
	process.exit(1);
}
const sessionId = sidecarName.replace(/\.jsonl$/, "");
const metas = readFileSync(join(shadowDir, sidecarName), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log(`[demo] session: ${sessionId}`);
console.log("════ shadow history recorded by the real session ════");
for (const m of metas) console.log(`t${m.turn} ${m.tool.padEnd(5)} ${m.sha.slice(0, 10)} files: ${m.files.join(",")}`);

console.log("\n════ bisect over the session's shadow history ════");
const { bisect } = await import(join(root, "packages", "pi-bisect", "src", "bisect.ts"));
const { spawnSync } = await import("node:child_process");

function testPassesAt(dir) {
	const r = spawnSync(process.execPath, [join(dir, "test.js")], { cwd: dir, encoding: "utf8" });
	return r.status === 0 && !`${r.stderr ?? ""}`.includes("Assertion failed");
}

let steps = 0;
const result = await bisect(
	metas.map((m) => m.sha),
	async (sha) => {
		steps++;
		const dir = mkdtempSync(join(tmpdir(), "bisect-demo-"));
		try {
			git(["worktree", "add", "--detach", "--quiet", dir, sha]);
			return testPassesAt(dir);
		} finally {
			try {
				git(["worktree", "remove", "--force", dir]);
			} catch {
				git(["worktree", "prune"]);
			}
		}
	},
);

if (!result.ok) {
	console.error("bisect failed:", result.reason);
	process.exit(1);
}
const culprit = metas[result.foundIndex];
const parent = metas[result.foundIndex - 1];
const diff = git(["diff", parent.sha, culprit.sha, "--"]);
console.log(diff.trim());
console.log(`\n🎯 culprit: edit #${result.foundIndex + 1} — turn ${culprit.turn}, tool ${culprit.tool}, prompt “${culprit.promptExcerpt}”, model ${culprit.model}`);
console.log(`found in ${steps} command runs`);

console.log("\n════ revert only that edit ════");
const { applyPatch } = await import(join(root, "packages", "core", "src", "git.ts"));
const { revertEdit } = await import(join(root, "packages", "pi-bisect", "src", "revert.ts"));
const reverse = diff
	.replace(/^--- a\/(.*)$/gm, "___TMP___ $1")
	.replace(/^\+\+\+ b\/(.*)$/gm, "+++ b/$1")
	.replace(/^___TMP___ (.*)$/gm, "--- a/$1");
const applied = await applyPatch(fixture, reverse);
let reverted = applied.applied ? `applied (${applied.mode})` : null;
if (!applied.applied) {
	// Later agent edits often change a hunk's context lines; fall back to the
	// content-anchored revert (same code path the extension uses).
	const result = await revertEdit(fixture, culprit, parent);
	reverted = result.filesChanged.length > 0 ? `content-anchored (${result.filesChanged.join(", ")})` : null;
	if (result.conflicts.length > 0) console.log(`conflicts: ${result.conflicts.join("; ")}`);
}
console.log(`reverse revert: ${reverted ?? "FAILED"}`);
const after = spawnSync(process.execPath, [join(fixture, "test.js")], { cwd: fixture, encoding: "utf8" });
const testGreen = after.status === 0 && !`${after.stderr ?? ""}`.includes("Assertion failed");
console.log(`node test.js after revert: ${testGreen ? "PASSES ✓" : "still failing ✗"}`);

const pass = Boolean(reverted) && testGreen;
console.log(pass ? "\nDEMO PASSED (bisect)" : "\nDEMO FAILED (bisect)");
process.exit(pass ? 0 : 1);
