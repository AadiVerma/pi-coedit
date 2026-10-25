import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRemaining, parseTtl, stateOf } from "../src/clock.ts";

// ---- formatRemaining ----

test("remaining time reads m:ss under an hour", () => {
	assert.equal(formatRemaining(299_000), "4:59");
	assert.equal(formatRemaining(60_000), "1:00");
	assert.equal(formatRemaining(5_000), "0:05");
});

test("remaining time reads h:mm:ss at an hour and past it", () => {
	assert.equal(formatRemaining(3_600_000), "1:00:00");
	assert.equal(formatRemaining(3_661_000), "1:01:01");
});

test("at or below zero the clock reads cold", () => {
	assert.equal(formatRemaining(0), "0:00");
	assert.equal(formatRemaining(-5_000), "0:00");
});

// ---- stateOf ----

test("a cache is warm while most of its window remains, cooling near the end, cold after", () => {
	assert.equal(stateOf(4_500_000, 5 * 60_000), "warm");
	assert.equal(stateOf(60_000, 5 * 60_000), "cooling");
	assert.equal(stateOf(30_000, 5 * 60_000), "cooling", "the last tenth still counts as cooling");
	assert.equal(stateOf(29_999, 5 * 60_000), "cold");
	assert.equal(stateOf(0, 5 * 60_000), "cold");
});

test("the thresholds scale with the ttl, not hardcoded minutes", () => {
	assert.equal(stateOf(50 * 60_000, 60 * 60_000), "warm");
	assert.equal(stateOf(10 * 60_000, 60 * 60_000), "cooling");
	assert.equal(stateOf(359_999, 60 * 60_000), "cold", "just under a tenth of the window");
	// And a tenth of an hour is exactly the cooling floor.
	assert.equal(stateOf(6 * 60_000, 60 * 60_000), "cooling");
});

// ---- parseTtl ----

test("the command understands 5m and 1h arguments", () => {
	assert.equal(parseTtl("5m"), 5 * 60_000);
	assert.equal(parseTtl("1h"), 60 * 60_000);
	assert.equal(parseTtl("30m"), 30 * 60_000);
	assert.equal(parseTtl("2h"), 120 * 60_000);
});

test("garbage and bare words return undefined", () => {
	assert.equal(parseTtl("warm"), undefined);
	assert.equal(parseTtl(""), undefined);
	assert.equal(parseTtl("5"), undefined);
	assert.equal(parseTtl("5x"), undefined);
});
