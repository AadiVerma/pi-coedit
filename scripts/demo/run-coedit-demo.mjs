#!/usr/bin/env node
// coedit scripted demo: builds a fixture repo, runs pi (real agent loop, scripted
// offline provider — no model credentials needed) while a "human" edits files
// concurrently, then extracts the evidence: attribution events, the human-diff
// note the agent received, and the overwrite guard blocking a stale edit.
//
//   node scripts/demo/run-coedit-demo.mjs [--stale]
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scenario = process.argv.includes("--stale") ? "stale-edit" : "edit";
const pi = join(process.env.HOME, ".pi/agent/bin/pi");

const fixture = mkdtempSync(join(tmpdir(), "coedit-demo-"));
const git = (args) => execFileSync("git", args, { cwd: fixture, stdio: "ignore" });
git(["init", "-q", "-b", "main"]);
git(["config", "user.name", "Demo Human"]);
git(["config", "user.email", "human@example.com"]);
writeFileSync(join(fixture, "a.js"), "function add(a, b) {\n  return a + b;\n}\n// TODO: implement\n");
writeFileSync(join(fixture, "b.js"), "console.log('b');\n");
git(["add", "."]);
git(["commit", "-qm", "init"]);

// The "human": 2 s in, edit a.js near the TODO region and touch b.js.
const humanEdits = setTimeout(() => {
	// Race-free human edits: append markers (the agent may have already rewritten the TODO).
	appendFileSync(join(fixture, "a.js"), "// human touched a.js — keep this line\n");
	appendFileSync(join(fixture, "b.js"), "// human touched b.js\n");
	console.log(`[demo] human edited a.js + b.js at ${new Date().toISOString()}`);
}, 2_000);

console.log(`[demo] fixture: ${fixture}\n[demo] scenario: ${scenario}\n`);
// Async spawn (not spawnSync): the runner's timers must keep firing while pi runs.
const result = await new Promise((resolveSpawn) => {
	const child = spawn(
		pi,
		[
			"--mode", "json",
			"-e", join(root, "packages", "pi-coedit"),
			"-e", join(root, "scripts", "demo", "demo-driver.ts"),
			"--model", "coedit-demo/scripted",
			"--no-session",
			"Please implement the TODO in a.js.",
		],
		{ cwd: fixture, env: { ...process.env, COEDIT_DEMO_SCENARIO: scenario }, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => (stdout += d));
	child.stderr.on("data", (d) => (stderr += d));
	const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
	child.on("close", (code) => {
		clearTimeout(killer);
		resolveSpawn({ code, stdout, stderr, error: undefined });
	});
});
clearTimeout(humanEdits);

if (result.error) {
	console.error("[demo] pi failed to run:", result.error);
	process.exit(1);
}
if (result.stderr.trim()) console.error(`[demo] pi stderr: ${result.stderr.trim().slice(0, 500)}`);

// ---- parse pi's JSON event stream ----------------------------------------
const events = result.stdout
	.split("\n")
	.filter((l) => l.trim().startsWith("{"))
	.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return null;
		}
	})
	.filter(Boolean);

const texts = [];
const toolResults = [];
for (const ev of events) {
	const msg = ev.message ?? ev.messages?.at(-1);
	if (ev.type === "message_end" && msg?.role === "assistant") {
		for (const block of msg.content ?? []) {
			if (block.type === "text") texts.push(block.text);
		}
	}
	if (ev.type === "message_end" && msg?.role === "toolResult") {
		toolResults.push({ toolName: msg.toolName, isError: msg.isError, text: (msg.content ?? []).map((c) => c.text ?? "").join("\n") });
	}
}

console.log("════ agent transcript (evidence) ════");
for (const t of texts) console.log(`assistant: ${t}`);
for (const tr of toolResults) {
	console.log(`tool ${tr.toolName}: ${tr.isError ? "ERROR" : "ok"} — ${tr.text.slice(0, 220).replaceAll("\n", " ⏎ ")}`);
}

console.log("\n════ coedit store (attribution evidence) ════");
const storeEventsPath = join(fixture, ".git", "coedit", "events.jsonl");
let storeEvents = [];
try {
	storeEvents = readFileSync(storeEventsPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
} catch {
	console.log("(no store events found)");
}
for (const e of storeEvents) {
	console.log(
		`${e.ts.slice(11, 19)} ${e.author.padEnd(7)} ${e.source.padEnd(8)} ${e.file} ${
			e.agent ? `[${e.agent.sessionId.slice(0, 8)} t${e.agent.turn} ${e.agent.model ?? ""}]` : ""
		}`,
	);
}

const humanNoteReceived = texts.some((t) => t.includes("user's edits"));
const guardBlocked = toolResults.some((tr) => tr.isError && tr.text.includes("coedit:"));
const agentEvent = storeEvents.find((e) => e.author === "agent" && e.source === "pi-edit");
const humanEvent = storeEvents.find((e) => e.author === "human");
const staleEvent = storeEvents.find((e) => e.agent?.toolCallId === "call_edit_2");

console.log("\n════ verdict ════");
console.log(`human-diff note reached the model: ${humanNoteReceived ? "✓" : "✗"}`);
console.log(`agent edit recorded with metadata: ${agentEvent ? "✓" : "✗"}`);
console.log(`human edit recorded: ${humanEvent ? "✓" : "✗"}`);
console.log(`overwrite guard blocked the stale edit: ${guardBlocked ? "✓" : "✗"}`);
console.log(`stale edit produced NO store event: ${staleEvent ? "✗ (recorded!)" : "✓"}`);
const pass = humanNoteReceived && agentEvent && humanEvent && (scenario !== "stale-edit" || guardBlocked) && !staleEvent;
console.log(pass ? `\nDEMO PASSED (${scenario})` : `\nDEMO FAILED (${scenario})`);
process.exit(pass ? 0 : 1);
