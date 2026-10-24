import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileLock } from "../src/lock.ts";
import { Store } from "../src/store.ts";
import { contentHash } from "../src/util.ts";
import { makeEvent, makeTempRepo } from "./helpers.ts";

async function openStore(repo: string): Promise<Store> {
	return Store.open(repo, join(repo, ".git"));
}

test("store records and reads events", async () => {
	const repo = makeTempRepo();
	const store = await openStore(repo);
	await store.recordEvent(makeEvent({ file: "a.ts", author: "agent" }));
	await store.recordEvent(makeEvent({ file: "b.ts", author: "human" }));
	assert.equal(store.events().length, 2);
	assert.equal(store.events({ file: "a.ts" }).length, 1);
	assert.equal(store.events({ worktree: "/other" }).length, 0);
	store.close();
});

test("state persists and migrates schema", async () => {
	const repo = makeTempRepo();
	const store = await openStore(repo);
	await store.markHead("abc123");
	store.close();
	const raw = JSON.parse(readFileSync(join(repo, ".git", "coedit", "state.json"), "utf8"));
	assert.equal(raw.schemaVersion, 1);
	assert.equal(raw.headByWorktree[repo], "abc123");
	const again = await openStore(repo);
	assert.equal(again.getState().headByWorktree[repo], "abc123");
	again.close();
});

test("concurrent writers under the lock do not lose events", async () => {
	const repo = makeTempRepo();
	const a = await openStore(repo);
	const b = await openStore(repo);
	await Promise.all(
		Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? a : b).recordEvent(makeEvent({ file: `f${i}.ts`, author: "human" }))),
	);
	assert.equal(a.events().length, 100);
	a.close();
	b.close();
});

test("stale locks are broken", async () => {
	const repo = makeTempRepo();
	const lock = new FileLock(join(repo, ".git", "coedit", "lock"));
	mkdirSync(join(repo, ".git", "coedit"), { recursive: true });
	writeFileSync(join(repo, ".git", "coedit", "lock"), JSON.stringify({ pid: 2 ** 26, ts: Date.now(), host: "other" }));
	const store = await openStore(repo);
	await store.recordEvent(makeEvent({ file: "a.ts", author: "agent" })); // must not hang
	assert.equal(store.events().length, 1);
	store.close();
	void lock;
});

test("lock timeout throws when held by a live process", async () => {
	const repo = makeTempRepo();
	const coeditDir = join(repo, ".git", "coedit");
	mkdirSync(coeditDir, { recursive: true });
	writeFileSync(coeditDir + "/lock", JSON.stringify({ pid: process.pid, ts: Date.now(), host: "here" }));
	const lock = new FileLock(coeditDir + "/lock");
	await assert.rejects(() => lock.with(async () => 1, 200));
});

test("corrupted state is backed up and store starts fresh", async () => {
	const repo = makeTempRepo();
	const coeditDir = join(repo, ".git", "coedit");
	mkdirSync(coeditDir, { recursive: true });
	writeFileSync(join(coeditDir, "state.json"), "{ not json !!!");
	const warn: string[] = [];
	const origWarn = console.warn;
	console.warn = (m: string) => warn.push(m);
	try {
		const store = await openStore(repo);
		store.close();
	} finally {
		console.warn = origWarn;
	}
	const backup = readFileSync(join(coeditDir, "state.json"), "utf8");
	assert.ok(warn.some((w) => w.includes("backed up")));
	assert.equal(JSON.parse(backup).schemaVersion, 1);
	assert.ok(readFileSync(join(coeditDir, "state.json"), "utf8").includes('"schemaVersion"'));
	const backups = (await import("node:fs")).readdirSync(coeditDir).filter((n) => n.startsWith("backup-"));
	assert.ok(backups.length >= 1);
});

test("blob cache round-trips and evicts", async () => {
	const repo = makeTempRepo();
	const store = await openStore(repo);
	const content = "hello world";
	const hash = store.cacheBlob(content);
	assert.equal(store.getBlob(hash), content);
	assert.equal(hash, contentHash(content));
	// Eviction: overfill and check the dir stays bounded.
	for (let i = 0; i < 520; i++) store.cacheBlob(`blob-${i}`);
	const blobs = (await import("node:fs")).readdirSync(join(repo, ".git", "coedit", "blobs"));
	assert.ok(blobs.length <= 500, `expected <=500 blobs, got ${blobs.length}`);
	store.close();
});

test("onStoreChange fires for events and state", async () => {
	const repo = makeTempRepo();
	const store = await openStore(repo);
	const seen: string[] = [];
	const off = store.onStoreChange((c) => seen.push(c.kind));
	await store.recordEvent(makeEvent({ file: "a.ts", author: "agent" }));
	await new Promise((r) => setTimeout(r, 120));
	assert.ok(seen.includes("events"));
	off();
	store.close();
});

test("events file survives a torn last line", async () => {
	const repo = makeTempRepo();
	const store = await openStore(repo);
	await store.recordEvent(makeEvent({ file: "a.ts", author: "agent" }));
	rmSync(join(repo, ".git", "coedit", "events.jsonl"), { force: true });
	writeFileSync(join(repo, ".git", "coedit", "events.jsonl"), JSON.stringify(makeEvent({ file: "b.ts", author: "human" })) + "\n{'torn");
	assert.equal(store.events().length, 1);
	store.close();
});
