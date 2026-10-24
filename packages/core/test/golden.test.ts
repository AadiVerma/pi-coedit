import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Coedit, computeHunks } from "../src/index.ts";
import { contentHash, splitLines } from "../src/util.ts";
import { git, makeTempRepo, writeFile } from "./helpers.ts";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "golden", "attribution.json");

interface GoldenShape {
	summary: Array<{ file: string; human: number; agent: number; both: number; unknown: number }>;
	attribution: Record<string, string[]>;
	humanDiffNote: string;
}

test("golden: human + agent + bash + unknown + overlap in one fixture repo", { timeout: 60_000 }, async () => {
	const repo = makeTempRepo();
	writeFile(repo, "a.js", "function add(a, b) {\n  return a + b;\n}\n");
	writeFile(repo, "b.js", "console.log('b');\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "init"]);

	const coedit = (await Coedit.open(repo))!;
	await coedit.track();

	const meta = { sessionId: "sess-demo-1", model: "test-model", turn: 1, promptExcerpt: "add a helper" };

	// 1. Agent writes a helper into a.js (edit tool), replacing line 2.
	const before = (await import("node:fs")).readFileSync(join(repo, "a.js"), "utf8");
	const after = "function add(a, b) {\n  return sum(a, b);\n}\n";
	writeFile(repo, "a.js", after);
	await coedit.recordEvent(
		{
			file: "a.js",
			author: "agent",
			source: "pi-edit",
			beforeHash: "x".repeat(64),
			afterHash: "y".repeat(64),
			hunks: computeHunks(splitLines(before), splitLines(after)),
			agent: meta,
		},
		{ before, after },
	);

	// 2. Human edits line 1 (editor), making line 1 'both'? No — line 1 untouched by agent: human.
	const hBefore = after;
	const hAfter = "// human header\nfunction add(a, b) {\n  return sum(a, b);\n}\n";
	writeFile(repo, "a.js", hAfter);
	await coedit.recordEvent(
		{
			file: "a.js",
			author: "human",
			source: "editor",
			beforeHash: "x".repeat(64),
			afterHash: "z".repeat(64),
			hunks: computeHunks(splitLines(hBefore), splitLines(hAfter)),
		},
		{ before: hBefore, after: hAfter },
	);

	// 3. Human then tweaks the agent-written line -> both.
	const b2 = hAfter;
	const b3 = "// human header\nfunction add(a, b) {\n  return sum(a, b) + 0; // human tweak\n}\n";
	writeFile(repo, "a.js", b3);
	await coedit.recordEvent(
		{
			file: "a.js",
			author: "human",
			source: "editor",
			beforeHash: "x".repeat(64),
			afterHash: "z".repeat(64),
			hunks: computeHunks(splitLines(b2), splitLines(b3)),
		},
		{ before: b2, after: b3 },
	);

	// 4. Agent creates c.js through bash (pi-bash), 5. Human change during the window -> unknown.
	const cContent = "// made by agent bash\nmodule.exports = 1;\n";
	writeFile(repo, "c.js", cContent);
	await coedit.recordEvent(
		{
			file: "c.js",
			author: "agent",
			source: "pi-bash",
			beforeHash: null,
			afterHash: "c".repeat(64),
			hunks: computeHunks([], splitLines(cContent)),
			agent: meta,
		},
		{ after: cContent },
	);
	const cAfter = "// made by agent bash\nmodule.exports = 1;\n// human during agent window\n";
	await coedit.recordEvent(
		{
			file: "c.js",
			author: "unknown",
			source: "editor",
			beforeHash: "c".repeat(64),
			afterHash: "d".repeat(64),
			hunks: computeHunks(splitLines(cContent), splitLines(cAfter)),
		},
		{ before: cContent, after: cAfter },
	);

	const summary = coedit.fileSummary();
	const attribution: Record<string, string[]> = {};
	for (const f of ["a.js", "c.js"]) {
		const attr = await coedit.attribution(f);
		attribution[f] = attr ? attr.lines.map((l) => l.origin) : [];
	}
	const humanDiff = (await coedit.humanChangesSince("a.js", contentHash(hBefore)))!;
	const actual: GoldenShape = {
		summary: summary.filter((s) => s.file === "a.js" || s.file === "c.js"),
		attribution,
		humanDiffNote: humanDiff.diffText,
	};

	if (process.env.UPDATE_GOLDEN) {
		writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
		console.log("golden updated");
	}
	const expected = JSON.parse(readFileSync(GOLDEN, "utf8")) as GoldenShape;
	assert.deepEqual(actual, expected);

	// The blob cache made the human diff reconstructable.
	assert.match(actual.humanDiffNote, /\+\/\/ human header/);
	coedit.close();
});

test("git ai note export is standard-shaped", { timeout: 60_000 }, async () => {
	const repo = makeTempRepo();
	writeFile(repo, "x.js", "one\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "init"]);
	const coedit = (await Coedit.open(repo))!;
	await coedit.track();
	await coedit.recordEvent({
		file: "x.js",
		author: "agent",
		source: "pi-write",
		beforeHash: null,
		afterHash: "a".repeat(64),
		hunks: [{ delStart: 0, delCount: 0, insStart: 0, insCount: 1 }],
		agent: { sessionId: "sess-42", model: "m" },
	});
	const note = await coedit.exportGitAiNote("deadbeef".repeat(5).slice(0, 40), { attach: false });
	assert.match(note, /^x\.js\n  s_[0-9a-f]{14}::t_[0-9a-f]{14} 1\n---\n\{/);
	assert.match(note, /"schema_version": "authorship\/3\.0\.0"/);
	assert.match(note, /"tool": "pi"/);
	coedit.close();
});
