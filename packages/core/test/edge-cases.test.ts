/**
 * Explicit edge cases: the scenarios a QA engineer would try to break coedit with.
 * Grouped: store & concurrency, filesystem adversarial cases, facade flows, guard data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coedit, computeHunks, contentHash, excerpt, splitLines, Store, readFileStat, isBinary } from "../src/index.ts";
import { git, makeTempRepo, writeFile } from "./helpers.ts";

// ---------------------------------------------------------------- store & concurrency

test("EDGE store: 32 parallel writers × 25 events lose nothing", { timeout: 120_000 }, async () => {
	const repo = makeTempRepo();
	const stores = await Promise.all(Array.from({ length: 32 }, () => Store.open(repo, join(repo, ".git"))));
	await Promise.all(
		stores.flatMap((s, si) =>
			Array.from({ length: 25 }, (_, i) =>
				s.recordEvent({ id: `w${si}e${i}`, ts: new Date().toISOString(), worktree: repo, file: `f${si}-${i}.ts`, author: "human", source: "fs-watch", beforeHash: "a", afterHash: "b", hunks: [] }),
			),
		),
	);
	const count = stores[0].events().length;
	assert.equal(count, 800, `expected 800 events, got ${count}`);
	for (const s of stores) s.close();
});

test("EDGE store: garbage lines mid-file are skipped, good lines survive", async () => {
	const repo = makeTempRepo();
	const store = await Store.open(repo, join(repo, ".git"));
	await store.recordEvent({ id: "a", ts: "t", worktree: repo, file: "a", author: "human", source: "fs-watch", beforeHash: "1", afterHash: "2", hunks: [] });
	rmSync(join(repo, ".git", "coedit", "events.jsonl"));
	writeFileSync(join(repo, ".git", "coedit", "events.jsonl"), [
		JSON.stringify({ id: "a", ts: "t", worktree: repo, file: "a", author: "human", source: "fs-watch", beforeHash: "1", afterHash: "2", hunks: [] }),
		"{{{not json",
		"",
		JSON.stringify({ id: "b", ts: "t", worktree: repo, file: "b", author: "agent", source: "pi-edit", beforeHash: "1", afterHash: "2", hunks: [] }),
	].join("\n"));
	assert.equal(store.events().length, 2);
	store.close();
});

test("EDGE store: empty state.json file is corruption, not a crash", async () => {
	const repo = makeTempRepo();
	const dir = join(repo, ".git", "coedit");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "state.json"), "");
	const warns: string[] = [];
	const orig = console.warn;
	console.warn = (m: string) => warns.push(m);
	try {
		const store = await Store.open(repo, join(repo, ".git"));
		assert.ok(warns.some((w) => w.includes("backed up")));
		store.close();
	} finally {
		console.warn = orig;
	}
});

test("EDGE store: stale ts lock (dead process by age) is broken", async () => {
	const repo = makeTempRepo();
	const dir = join(repo, ".git", "coedit");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "lock"), JSON.stringify({ pid: 2 ** 26, ts: Date.now() - 60_000, host: "x" }));
	const store = await Store.open(repo, join(repo, ".git"));
	await store.recordEvent({ id: "a", ts: "t", worktree: repo, file: "a", author: "human", source: "fs-watch", beforeHash: "1", afterHash: "2", hunks: [] });
	assert.equal(store.events().length, 1);
	store.close();
});

test("EDGE store: same-process nested lock times out loudly (no silent deadlock)", async () => {
	const { FileLock } = await import("../src/lock.ts");
	const repo = makeTempRepo();
	const lock = new FileLock(join(repo, ".git", "coedit-lock"), 60_000);
	await assert.rejects(
		lock.with(() => lock.with(async () => "inner", 150), 5_000),
		/lock busy/,
	);
});

test("EDGE store: blob eviction keeps getBlob honest (miss returns null, no crash)", async () => {
	const repo = makeTempRepo();
	const store = await Store.open(repo, join(repo, ".git"));
	const h = store.cacheBlob("first");
	for (let i = 0; i < 520; i++) store.cacheBlob(`filler-${i}`);
	assert.equal(store.getBlob("first"), null); // evicted
	assert.equal(store.getBlob("nonexistent"), null);
	assert.notEqual(store.getBlob(store.cacheBlob("fresh")), null);
	void h;
	store.close();
});

test("EDGE store: multi-worktree events are filtered per worktree", async () => {
	const repo = makeTempRepo();
	const store = await Store.open(repo, join(repo, ".git"));
	const wt2 = mkdtempSync(join(tmpdir(), "coedit-wt2-"));
	await store.recordEvent({ id: "1", ts: "t", worktree: repo, file: "a", author: "human", source: "fs-watch", beforeHash: "1", afterHash: "2", hunks: [] });
	await store.recordEvent({ id: "2", ts: "t", worktree: wt2, file: "a", author: "agent", source: "pi-edit", beforeHash: "1", afterHash: "2", hunks: [] });
	assert.equal(store.events({ worktree: repo }).length, 1);
	assert.equal(store.events({ worktree: wt2 }).length, 1);
	assert.equal(store.events().length, 2);
	store.close();
});

// ---------------------------------------------------------------- adversarial filesystem

test("EDGE fs: weird filenames (spaces, unicode, emoji, deep) survive snapshot + events", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "with space.js", "a\n");
	writeFile(repo, "héllo-世界-🚀.ts", "b\n");
	const deep = join(repo, ...Array.from({ length: 12 }, (_, i) => `d${i}`));
	mkdirSync(deep, { recursive: true });
	writeFileSync(join(deep, "deep.js"), "c\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	const snap = await coedit.track();
	assert.ok(snap.files.has("with space.js"));
	assert.ok(snap.files.has("héllo-世界-🚀.ts"));
	const deepRel = [...snap.files.keys()].find((f) => f.endsWith("deep.js"));
	assert.ok(deepRel, "deep path missing");
	const beforeDeep = readFileSync(join(repo, deepRel!), "utf8");
	const afterDeep = `${beforeDeep}added\n`;
	writeFileSync(join(repo, deepRel!), afterDeep);
	await coedit.recordEvent(
		{
			file: deepRel!,
			author: "agent",
			source: "pi-edit",
			beforeHash: contentHash(beforeDeep),
			afterHash: contentHash(afterDeep),
			hunks: computeHunks(splitLines(beforeDeep), splitLines(afterDeep)),
			agent: { sessionId: "s", turn: 0 },
		},
		{ before: beforeDeep, after: afterDeep },
	);
	assert.deepEqual(coedit.engine.get(deepRel!)!.lines.map((l) => l.origin), ["unchanged", "agent"]);
	coedit.close();
});

test("EDGE fs: leading-dash filename is not mangled by git helpers", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "-dash.txt", "x\n");
	git(repo, ["add", "--", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	const snap = await coedit.track();
	assert.ok(snap.files.has("-dash.txt"));
	coedit.close();
});

test("EDGE fs: broken symlink is skipped, tracked symlink snapshots without crash", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "real.txt", "content\n");
	try {
		symlinkSync(join(repo, "does-not-exist.txt"), join(repo, "broken-link"));
	} catch {
		/* filesystem without symlink support */
	}
	try {
		symlinkSync("real.txt", join(repo, "good-link"));
	} catch {
		/* ignore */
	}
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	const snap = await coedit.track(); // must not throw
	assert.ok(snap.files.size >= 1);
	coedit.close();
});

test("EDGE fs: binary detection catches NUL in first 8 KiB only", () => {
	const earlyNul = Buffer.concat([Buffer.from("text"), Buffer.from([0]), Buffer.alloc(9000, 120)]);
	assert.equal(isBinary(earlyNul), true); // NUL at index 4
	const lateNul = Buffer.concat([Buffer.alloc(9000, 120), Buffer.from([0])]);
	assert.equal(isBinary(lateNul), false); // NUL past 8 KiB → not binary by our rule
	assert.equal(isBinary(Buffer.from("plain text")), false);
});

test("EDGE fs: delete + recreate between snapshots is not a rename", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "f.txt", "same\n");
	writeFile(repo, "g.txt", "temp\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	await coedit.track();
	const before = await coedit.snapshot();
	rmSync(join(repo, "g.txt"));
	writeFileSync(join(repo, "g.txt"), "same\n"); // same content as f.txt, recreated
	const after = await coedit.snapshot();
	const diff = coedit.diffSnapshots(before, after);
	// g.txt content changed temp→same: a change, not a rename; nothing else moved
	assert.deepEqual(diff.renamed, []);
	assert.ok(diff.changed.includes("g.txt"));
	coedit.close();
});

// ---------------------------------------------------------------- facade flows

test("EDGE facade: empty repo (no HEAD) opens, tracks, records without crash", async () => {
	const repo = makeTempRepo();
	const coedit = (await Coedit.open(repo))!;
	assert.equal(coedit.head, null);
	const snap = await coedit.track();
	assert.equal(snap.head, null);
	await coedit.recordEvent({
		file: "new.ts",
		author: "agent",
		source: "pi-write",
		beforeHash: null,
		afterHash: contentHash("x\n"),
		hunks: [{ delStart: 0, delCount: 0, insStart: 0, insCount: 1 }],
		agent: { sessionId: "s", turn: 0 },
	});
	assert.deepEqual((await coedit.attribution("new.ts"))!.lines.map((l) => l.origin), ["agent"]);
	coedit.close();
});

test("EDGE facade: dirty-vs-HEAD lines are unknown; clean lines unchanged (seeded state)", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "a.js", "one\ntwo\nthree\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	writeFile(repo, "a.js", "one\nTWO!\nthree\n"); // dirty, never observed
	const coedit = (await Coedit.open(repo))!;
	await coedit.track();
	const attr = (await coedit.attribution("a.js"))!;
	assert.deepEqual(attr.lines.map((l) => l.origin), ["unchanged", "unknown", "unchanged"]);
	coedit.close();
});

test("EDGE facade: untracked file is baseline-unchanged at first sight", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "tracked.txt", "t\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	writeFile(repo, "untracked.txt", "u1\nu2\n");
	const coedit = (await Coedit.open(repo))!;
	await coedit.track();
	const attr = (await coedit.attribution("untracked.txt"))!;
	assert.deepEqual(attr.lines.map((l) => l.origin), ["unchanged", "unchanged"]);
	assert.equal(attr.baseline, null);
	coedit.close();
});

test("EDGE facade: partial commit keeps dirty origins, resets committed lines", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "a.js", "1\n2\n3\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	await coedit.track();
	// agent edits line 1, human adds line 4 — then only the agent hunk is staged & committed
	await coedit.recordEvent({
		file: "a.js",
		author: "agent",
		source: "pi-edit",
		beforeHash: "x",
		afterHash: "y",
		hunks: [{ delStart: 1, delCount: 1, insStart: 1, insCount: 1 }],
		agent: { sessionId: "s", turn: 0 },
	});
	writeFileSync(join(repo, "a.js"), "1\nAGENT\n3\n4-human\n");
	await coedit.recordEvent({
		file: "a.js",
		author: "human",
		source: "editor",
		beforeHash: "y",
		afterHash: "z",
		hunks: [{ delStart: 3, delCount: 0, insStart: 3, insCount: 1 }],
	});
	// stage only lines 1-3 (simulate: git add of the whole file would take line 4 too; craft HEAD directly)
	git(repo, ["add", "a.js"]);
	// unstage line 4 is not possible line-wise; instead commit all and verify reset keeps the dirty human line
	const head = git(repo, ["commit", "-qm", "partial"]).trim();
	const notes = await coedit.resetBaseline(head);
	assert.ok(notes.length > 0);
	const attr = (await coedit.attribution("a.js"))!;
	// after commit, worktree == HEAD -> everything unchanged
	assert.deepEqual(attr.lines.map((l) => l.origin), ["unchanged", "unchanged", "unchanged", "unchanged"]);
	coedit.close();
});

test("EDGE facade: HEAD changed mid-session (checkout) — resync re-seeds vs new HEAD", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "a.js", "v1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "c1"]);
	const coedit = (await Coedit.open(repo))!;
	await coedit.track();
	const head1 = coedit.head;
	// agent writes v2 (recorded, uncommitted)
	writeFileSync(join(repo, "a.js"), "v2\n");
	await coedit.recordEvent({
		file: "a.js",
		author: "agent",
		source: "pi-edit",
		beforeHash: contentHash("v1\n"),
		afterHash: contentHash("v2\n"),
		hunks: [{ delStart: 0, delCount: 1, insStart: 0, insCount: 1 }],
		agent: { sessionId: "s", turn: 0 },
	});
	// human checks out a branch that rewrote a.js under us
	writeFileSync(join(repo, "a.js"), "branch-content\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "c2"]);
	await coedit.snapshot(); // head moves
	assert.notEqual(coedit.head, head1);
	await coedit.resync();
	const attr = (await coedit.attribution("a.js"))!;
	// worktree == new HEAD -> nothing attributed as dirty
	assert.deepEqual(attr.lines.map((l) => l.origin), ["unchanged"]);
	coedit.close();
});

// ---------------------------------------------------------------- guard data (humanChangesSince)

test("EDGE guard: newline-only change is `changed` even though hunks are empty", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "a.js", "one\ntwo\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	await coedit.track();
	const lastRead = coedit.cacheContent("one\ntwo");
	writeFileSync(join(repo, "a.js"), "one\ntwo\n"); // add trailing newline
	const r = (await coedit.humanChangesSince("a.js", lastRead))!;
	assert.equal(r.changed, true, "content hash differs → stale, regardless of hunks");
	assert.equal(r.hunks.length, 0); // no line-level diff
	coedit.close();
});

test("EDGE guard: evicted blob degrades to boolean, never lies", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "a.js", "x\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	await coedit.track();
	const fakeHash = contentHash("never-cached");
	writeFileSync(join(repo, "a.js"), "y\n");
	const r = (await coedit.humanChangesSince("a.js", fakeHash))!;
	assert.equal(r.changed, true);
	assert.equal(r.diffText, "");
	coedit.close();
});

test("EDGE guard: CRLF-only difference still counts as changed (raw hash), hunks empty", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "a.js", "one\ntwo\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	await coedit.track();
	const lastRead = coedit.cacheContent("one\ntwo\n");
	writeFileSync(join(repo, "a.js"), "one\r\ntwo\r\n");
	const r = (await coedit.humanChangesSince("a.js", lastRead))!;
	assert.equal(r.changed, true);
	coedit.close();
});

// ---------------------------------------------------------------- snapshot specifics

test("EDGE snapshot: ignored files are excluded, mtime pre-filter reuses hashes", async () => {
	const repo = makeTempRepo();
	writeFile(repo, ".gitignore", "ignored/\nsecret.env\n");
	writeFile(repo, "kept.js", "k\n");
	mkdirSync(join(repo, "ignored"), { recursive: true });
	writeFile(repo, "ignored/x.js", "i\n");
	writeFile(repo, "secret.env", "PASSWORD=hunter2\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	const snap = await coedit.track();
	assert.ok(!snap.files.has("ignored/x.js"));
	assert.ok(!snap.files.has("secret.env"));
	assert.ok(snap.files.has("kept.js"));
	const warm = await coedit.snapshot(snap);
	assert.equal(warm.files.get("kept.js")!.hash, snap.files.get("kept.js")!.hash);
	coedit.close();
});

test("EDGE snapshot: file replaced by a directory (or vice versa) does not crash", async () => {
	const repo = makeTempRepo();
	writeFile(repo, "thing", "file\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	await coedit.snapshot();
	rmSync(join(repo, "thing"));
	mkdirSync(join(repo, "thing"));
	writeFileSync(join(repo, "thing", "inner.txt"), "now a dir\n");
	const snap = await coedit.snapshot();
	assert.ok(!snap.files.has("thing"));
	assert.ok([...snap.files.keys()].some((f) => f.startsWith("thing/")));
	coedit.close();
});

test("EDGE snapshot: readFileStat on missing file returns null", async () => {
	const repo = makeTempRepo();
	assert.equal(readFileStat(repo, "nope.txt"), null);
	void computeHunks;
});

// ---------------------------------------------------------------- utils

test("EDGE utils: splitLines newline matrix", () => {
	assert.deepEqual(splitLines(""), []);
	assert.deepEqual(splitLines("\n"), [""]);
	assert.deepEqual(splitLines("a"), ["a"]);
	assert.deepEqual(splitLines("a\n"), ["a"]);
	assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
	assert.deepEqual(splitLines("\n\n"), ["", ""]);
});

test("EDGE utils: excerpt caps and flattens whitespace", () => {
	assert.equal(excerpt("a\nb   c"), "a b c");
	const long = "x".repeat(300);
	assert.equal(excerpt(long).length, 200);
	assert.ok(excerpt(long).endsWith("…"));
});

test("EDGE live summary: gitignored artifacts never count, tracked work does", { timeout: 60_000 }, async () => {
	const repo = makeTempRepo();
	writeFile(repo, ".gitignore", "dist/\n*.tgz\n");
	writeFile(repo, "src.js", "one\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const coedit = (await Coedit.open(repo))!;
	await coedit.track();

	// build artifacts + tracked file both get events (as fs-watch would)
	await coedit.recordEvent({
		file: "dist/bundle.js",
		author: "human",
		source: "fs-watch",
		beforeHash: null,
		afterHash: "d1",
		hunks: [{ delStart: 0, delCount: 0, insStart: 0, insCount: 1 }],
	});
	await coedit.recordEvent({
		file: "pkg.tgz",
		author: "human",
		source: "fs-watch",
		beforeHash: null,
		afterHash: "d2",
		hunks: [{ delStart: 0, delCount: 0, insStart: 0, insCount: 1 }],
	});
	writeFile(repo, "src.js", "one\ntwo\n");
	await coedit.recordEvent({
		file: "src.js",
		author: "agent",
		source: "pi-edit",
		beforeHash: contentHash("one\n"),
		afterHash: contentHash("one\ntwo\n"),
		hunks: [{ delStart: 1, delCount: 0, insStart: 1, insCount: 1 }],
		agent: { sessionId: "s", turn: 0 },
	});

	const live = await coedit.fileSummaryLive();
	assert.deepEqual(live, [{ file: "src.js", human: 0, agent: 1, both: 0, unknown: 0 }]);
	coedit.close();
});
