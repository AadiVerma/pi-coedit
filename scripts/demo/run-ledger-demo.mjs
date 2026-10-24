#!/usr/bin/env node
// pi-ledger demo: a real pi session (scripted provider) makes 2 agent edits with
// per-turn cost; then the post-commit hook (installed by the CLI) writes the
// cost note for the commit, and show/blame/range print their reports.
//
//   node scripts/demo/run-ledger-demo.mjs
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pi = join(process.env.HOME, ".pi/agent/bin/pi");
const cli = join(root, "packages", "pi-ledger", "src", "cli.ts");

const fixture = mkdtempSync(join(tmpdir(), "coedit-ledger-demo-"));
const git = (args, input) => execFileSync("git", args, { cwd: fixture, encoding: "utf8", ...(input !== undefined ? { input } : {}) });
git(["init", "-q", "-b", "main"]);
git(["config", "user.name", "Demo Human"]);
git(["config", "user.email", "human@example.com"]);
writeFileSync(join(fixture, "a.js"), "const x = 1;\n");
writeFileSync(join(fixture, "b.js"), "console.log('b');\n");
git(["add", "."]);
git(["commit", "-qm", "init"]);

console.log(`[demo] fixture: ${fixture}`);
console.log("[demo] installing the post-commit hook via the CLI...");
const install = spawnSync(process.execPath, [cli, "install"], { cwd: fixture, encoding: "utf8" });
console.log(install.stdout.trim() || install.stderr.trim());

console.log("\n[demo] running the real pi session (2 agent edits with per-turn cost)...");
await new Promise((resolveSpawn) => {
	const child = spawn(
		pi,
		["--mode", "json", "-ne", "-e", join(root, "packages", "pi-coedit"), "-e", join(root, "packages", "pi-ledger"), "-e", join(root, "scripts", "demo", "ledger-driver.ts"), "--model", "coedit-demo/scripted", "--no-session", "Make some improvements."],
		{ cwd: fixture, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let out = "";
	let err = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (err += d));
	child.on("close", (code) => resolveSpawn({ code, out, err }));
});

writeFileSync(join(fixture, "a.js"), `${readFileSync(join(fixture, "a.js"), "utf8")}\n// human tweak after the agent\n`);
git(["add", "."]);
git(["commit", "-qm", "feat: agent edits + human tweak"]);
// the hook chain fires on commit — give it a moment
console.log("[demo] committed (post-commit hook ran)");

console.log("\n════ pi-ledger show ════");
const show = spawnSync(process.execPath, [cli, "show"], { cwd: fixture, encoding: "utf8" });
console.log(show.stdout.trim() || show.stderr.trim());

console.log("\n════ pi-ledger blame a.js ════");
const blame = spawnSync(process.execPath, [cli, "blame", "a.js"], { cwd: fixture, encoding: "utf8" });
console.log(blame.stdout.trim() || blame.stderr.trim());

console.log("\n════ pi-ledger range HEAD~1..HEAD ════");
const range = spawnSync(process.execPath, [cli, "range", "HEAD~1..HEAD"], { cwd: fixture, encoding: "utf8" });
console.log(range.stdout.trim() || range.stderr.trim());

let rawNote = null;
try { rawNote = git(["notes", "--ref=pi-ledger", "show", "HEAD"]); } catch { console.log("(no ledger note on HEAD)"); }
const note = rawNote ? JSON.parse(rawNote) : { sessions: [], edits: [] };
const pass =
	note.sessions.length > 0 &&
	note.sessions[0].costUsd > 0 &&
	note.edits.length >= 1 &&
	show.status === 0 &&
	range.status === 0 &&
	existsSync(join(fixture, ".git", "hooks", "post-commit"));
console.log(`\nnote check: sessions=${note.sessions.length} edits=${note.edits.length} cost=$${note.sessions[0]?.costUsd}`);
console.log(pass ? "DEMO PASSED (ledger)" : "DEMO FAILED (ledger)");
process.exit(pass ? 0 : 1);
