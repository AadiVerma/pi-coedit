import { test } from "node:test";
import assert from "node:assert/strict";
import { HelperStore } from "../src/helpers.ts";

test("a spawn makes a running helper with a seat, hue and start time", () => {
	const store = new HelperStore();
	const h = store.spawn("call-1", "Build the landing page", 1000);
	assert.equal(h.status, "running");
	assert.equal(h.label, "Build the landing page");
	assert.equal(h.seat, 0);
	assert.equal(h.startedAt, 1000);
	assert.ok(h.hue >= 0 && h.hue < 8);
});

test("two running helpers never share a hue", () => {
	const store = new HelperStore();
	store.spawn("c1", "One", 0);
	store.spawn("c2", "Two", 0);
	const hues = store.all.map((h) => h.hue);
	assert.equal(new Set(hues).size, 2);
});

test("a finished helper frees its hue: the next spawn never takes a running hue, and walks on in order", () => {
	const store = new HelperStore();
	const a = store.spawn("c1", "One", 0);
	store.spawn("c2", "Two", 0);
	store.finish("c1", false, 5000);
	const c = store.spawn("c3", "Three", 6000);
	// The hue pointer walks on (0, 1, then 2); it never lands on the still-running hue 1.
	assert.equal(c.hue, 2);
	assert.notEqual(c.hue, store.find("c2")!.hue);
	assert.equal(a.hue, 0);
});

test("with all 8 hues taken, the ninth still spawns (next hue in order)", () => {
	const store = new HelperStore();
	for (let i = 0; i < 8; i++) store.spawn(`c${i}`, `H${i}`, 0);
	const ninth = store.spawn("c9", "H9", 0);
	assert.ok(ninth.hue >= 0 && ninth.hue < 8);
	assert.equal(store.all.length, 9);
});

test("finishing a running helper marks it done and stamps the end time", () => {
	const store = new HelperStore();
	store.spawn("c1", "One", 1000);
	const done = store.finish("c1", false, 5500);
	assert.equal(done?.status, "done");
	assert.equal(done?.endedAt, 5500);
});

test("an errored result marks the helper stopped", () => {
	const store = new HelperStore();
	store.spawn("c1", "One", 1000);
	const stopped = store.finish("c1", true, 5500);
	assert.equal(stopped?.status, "stopped");
});

test("finishing an unknown call id is a no-op", () => {
	const store = new HelperStore();
	assert.equal(store.finish("nope", false, 0), undefined);
	assert.equal(store.all.length, 0);
});

test("spawning the same call id twice keeps one helper and updates its label", () => {
	const store = new HelperStore();
	store.spawn("c1", "First read", 0);
	const again = store.spawn("c1", "Better label", 100);
	assert.equal(store.all.length, 1);
	assert.equal(again.label, "Better label");
	assert.equal(again.startedAt, 0, "the original start time stands");
});

test("a stopped or done helper that spawns again goes back to running", () => {
	const store = new HelperStore();
	store.spawn("c1", "One", 0);
	store.finish("c1", false, 1000);
	const again = store.spawn("c1", "One again", 2000);
	assert.equal(again.status, "running");
	assert.equal(again.endedAt, undefined);
});

test("groups split by status", () => {
	const store = new HelperStore();
	store.spawn("c1", "A", 0);
	store.spawn("c2", "B", 0);
	store.spawn("c3", "C", 0);
	store.finish("c1", false, 100);
	store.finish("c2", true, 100);
	assert.equal(store.running.length, 1);
	assert.equal(store.finished.length, 1);
	assert.equal(store.stopped.length, 1);
	assert.equal(store.running[0]?.label, "C");
	assert.equal(store.stopped[0]?.label, "B");
});

test("seats count spawns in start order, even after finishes", () => {
	const store = new HelperStore();
	store.spawn("c1", "A", 0);
	store.spawn("c2", "B", 0);
	store.finish("c1", false, 10);
	const c3 = store.spawn("c3", "C", 20);
	assert.equal(c3.seat, 2);
});

test("find returns the helper for a call id, or undefined", () => {
	const store = new HelperStore();
	store.spawn("c1", "A", 0);
	assert.equal(store.find("c1")?.label, "A");
	assert.equal(store.find("zz"), undefined);
});

test("clear empties the desk (a new chat starts clean)", () => {
	const store = new HelperStore();
	store.spawn("c1", "A", 0);
	store.clear();
	assert.equal(store.all.length, 0);
	const h = store.spawn("c2", "B", 5);
	assert.equal(h.seat, 0, "seats restart with the desk");
});
