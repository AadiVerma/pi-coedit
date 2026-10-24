import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bisect, parseTimeout } from "../src/bisect.ts";
import { revertEdit } from "../src/revert.ts";
import { ShadowHistory } from "../src/shadow.ts";
import { git, makeTempRepo } from "./helpers.ts";

test("EDGE bisect: 0 and 1 snapshot ranges are explained, not crashed", async () => {
	const r0 = await bisect([], async () => true);
	assert.ok(!r0.ok);
	const one = ["a".repeat(40)];
	const r1 = await bisect(one, async () => true);
	assert.ok(!r1.ok);
	if (!r1.ok) assert.match(r1.reason, /only one/);
});

test("EDGE bisect: 2 snapshots resolve with exactly 2 endpoint runs", async () => {
	let runs = 0;
	const r = await bisect(["good", "bad"], async (sha) => {
		runs++;
		return sha === "good";
	});
	assert.ok(r.ok && r.foundIndex === 1);
	assert.equal(runs, 2);
});

test("EDGE bisect: non-monotonic (two broken regions) still lands on a broken snapshot", async () => {
	// broken at index 2 and index 7 of 10 — classic non-monotonic case
	const shas = Array.from({ length: 10 }, (_, i) => `sha-${i}`);
	const r = await bisect(shas, async (sha) => {
		const i = shas.indexOf(sha);
		return i !== 2 && i !== 7 && i !== 8 && i !== 9 ? true : i < 7; // 7,8,9 bad; 2 bad
	});
	// With a non-monotonic predicate the result is SOME bad/good boundary; assert it
	// never reports a good snapshot as the culprit.
	assert.ok(r.ok);
	if (r.ok) assert.notEqual(r.foundIndex, 0);
	assert.ok([2, 7, 8, 9].includes(r.foundIndex), `found ${r.foundIndex}`);
});

test("EDGE parseTimeout: unit matrix", () => {
	assert.equal(parseTimeout("5m"), 300_000);
	assert.equal(parseTimeout("90s"), 90_000);
	assert.equal(parseTimeout("4500"), 4500);
	assert.equal(parseTimeout("2h"), 7_200_000);
	assert.equal(parseTimeout("250ms"), 250);
	assert.equal(parseTimeout("garbage"), 300_000);
	assert.equal(parseTimeout(undefined), 300_000);
});

test("EDGE revert: culprit deleted a file — revert recreates it from the parent", async () => {
	const repo = makeTempRepo();
	writeFileSync(join(repo, "keep.txt"), "keep\n");
	writeFileSync(join(repo, "doomed.txt"), "doomed\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const history = new ShadowHistory(repo, join(repo, ".git", "coedit"), "s-del");
	writeFileSync(join(repo, "doomed.txt"), "still-here\n");
	await history.record({ turn: 1, toolCallId: "c1", tool: "edit", files: ["doomed.txt"], model: "m" });
	rmQuiet(join(repo, "doomed.txt"));
	await history.record({ turn: 2, toolCallId: "c2", tool: "bash", files: ["doomed.txt"], model: "m" });
	const metas2 = await history.history();

	const result = await revertEdit(repo, metas2[1], metas2[0]);
	assert.ok(result.filesChanged.includes("doomed.txt"), JSON.stringify(result));
	assert.equal(readFileSync(join(repo, "doomed.txt"), "utf8"), "still-here\n");
});

test("EDGE revert: file missing from the worktree is a conflict, not a crash", async () => {
	const repo = makeTempRepo();
	writeFileSync(join(repo, "x.txt"), "x\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const history = new ShadowHistory(repo, join(repo, ".git", "coedit"), "s-missing");
	writeFileSync(join(repo, "x.txt"), "y\n");
	await history.record({ turn: 1, toolCallId: "c1", tool: "edit", files: ["x.txt"], model: "m" });
	const metas = await history.history();
	rmQuiet(join(repo, "x.txt")); // gone entirely
	const result = await revertEdit(repo, metas[0], { ...metas[0], sha: metas[0].sha });
	assert.ok(result.conflicts.some((c) => c.includes("missing") || c.includes("x.txt")), JSON.stringify(result));
});

import { rmSync } from "node:fs";
function rmQuiet(p: string): void {
	try {
		rmSync(p);
	} catch {
		/* ignore */
	}
}
