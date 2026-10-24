import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bisect } from "../src/bisect.ts";
import { ShadowHistory } from "../src/shadow.ts";
import { git, makeTempRepo } from "./helpers.ts";

/**
 * Fixture: 20 synthetic agent edits; edit #13 (1-based) changes add() to
 * subtract — the breaking change for `node test.js`. Shadow history uses the
 * real plumbing (temp index -> write-tree -> commit-tree -> update-ref).
 */
async function buildFixture(): Promise<{ repo: string; metas: Awaited<ReturnType<ShadowHistory["history"]>> }> {
	const repo = makeTempRepo();
	const utilPath = join(repo, "util.js");
	writeFileSync(utilPath, "module.exports.add = (a, b) => a + b;\n");
	writeFileSync(
		join(repo, "test.js"),
		"const { add } = require('./util.js');\nconsole.assert(add(1, 1) === 2, 'add broken');\nconsole.log('ok');\n",
	);
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);

	const history = new ShadowHistory(repo, join(repo, ".git", "coedit"), "sess-bisect-1");
	for (let i = 1; i <= 20; i++) {
		const current = readFileSync(utilPath, "utf8");
		writeFileSync(utilPath, i === 13 ? current.replace("a + b", "a - b") : `${current}// edit ${i}\n`);
		await history.record({
			turn: i,
			toolCallId: `call_${i}`,
			tool: "edit",
			files: ["util.js"],
			model: "test-model",
			promptExcerpt: `edit ${i}`,
		});
	}
	return { repo, metas: await history.history() };
}

async function runTestInWorktree(repo: string, sha: string): Promise<boolean> {
	const dir = mkdtempSync(join(tmpdir(), "bisect-test-"));
	try {
		git(repo, ["worktree", "add", "--detach", "--quiet", dir, sha]);
		try {
			execNode(join(dir, "test.js"), dir);
			return true;
		} catch {
			return false;
		}
	} finally {
		try {
			git(repo, ["worktree", "remove", "--force", dir]);
		} catch {
			git(repo, ["worktree", "prune"]);
		}
	}
}

function execNode(script: string, cwd: string): void {
	// console.assert prints to stderr and exits 0 — treat a failed assert as failure.
	const r = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
	const out = (r.stdout ?? "") + (r.stderr ?? "");
	if (r.status !== 0 || out.includes("Assertion failed")) throw new Error("test failed");
}

test("20-edit fixture: bisect finds edit 13 in at most 5 search steps", async () => {
	const { repo, metas } = await buildFixture();
	assert.equal(metas.length, 20);

	let runs = 0;
	const result = await bisect(
		metas.map((m) => m.sha),
		async (sha) => {
			runs++;
			return runTestInWorktree(repo, sha);
		},
	);
	assert.ok(result.ok, `bisect failed: ${!result.ok && result.reason}`);
	if (result.ok) {
		assert.equal(result.foundIndex, 12); // 0-based → edit #13
		// 2 endpoint runs + ≤ ceil(log2(19)) = 5 search steps
		assert.ok(result.steps <= 7, `expected ≤7 runs, got ${result.steps}`);
		assert.equal(runs, result.steps);
	}
});

test("flaky command: any failure across --runs N marks the snapshot bad", async () => {
	const { metas } = await buildFixture();
	// Simulate --runs 2: first attempt flakes (fails) on good snapshots, retry passes;
	// broken snapshots fail both attempts. The wrapper matches runCommandInSnapshot.
	const result = await bisect(
		metas.map((m) => m.sha),
		async (sha) => {
			const broken = metas.findIndex((m) => m.sha === sha) >= 12;
			let pass = false;
			for (let run = 0; run < 2; run++) {
				const flakyFail = run === 0; // first attempt always "fails" on good snapshots
				if (!broken && !flakyFail) pass = true;
			}
			return pass;
		},
	);
	assert.ok(result.ok);
	if (result.ok) assert.equal(result.foundIndex, 12);
});

test("never passed: command fails at the oldest snapshot -> bisect explains and stops", async () => {
	const { metas } = await buildFixture();
	const result = await bisect(
		metas.map((m) => m.sha),
		async () => false,
	);
	assert.ok(!result.ok);
	if (!result.ok) assert.match(result.reason, /OLDEST/);
});

test("passes everywhere: command passes at the newest snapshot -> bisect explains and stops", async () => {
	const { metas } = await buildFixture();
	const result = await bisect(
		metas.map((m) => m.sha),
		async () => true,
	);
	assert.ok(!result.ok);
	if (!result.ok) assert.match(result.reason, /PASSES at the newest/);
});

test("shadow history: refs + sidecar exist, HEAD untouched, unchanged trees skipped", async () => {
	const { repo, metas } = await buildFixture();
	const refs = git(repo, ["for-each-ref", "--format=%(refname)", "refs/coedit/edits/"]);
	assert.match(refs, /refs\/coedit\/edits\/sess-bisect-1/);
	assert.equal(metas.length, 20);
	assert.equal(metas[12].turn, 13);
	const head = git(repo, ["rev-parse", "HEAD"]).trim();
	assert.ok(!metas.some((m) => m.sha === head));
	// The user's index was never touched: nothing staged beyond the initial commit
	// (the working tree is dirty by design — the 20 agent edits are uncommitted).
	assert.equal(git(repo, ["diff", "--cached", "--name-only"]).trim(), "");
});
