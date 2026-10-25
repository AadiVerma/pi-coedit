import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRemaining, parseTtl, stateOf, FIVE_MIN } from "../src/clock.ts";

// ---- formatRemaining: second-by-second across the first minute ----

for (let s = 0; s <= 60; s++) {
	test(`format ${s}s → 0:${String(s).padStart(2, "0")}`, () => {
		const want = s < 60 ? `0:${String(s).padStart(2, "0")}` : "1:00";
		assert.equal(formatRemaining(s * 1000), want);
	});
}

test("ceil: 4_999ms shows 0:05, 5_000ms shows 0:05", () => {
	assert.equal(formatRemaining(4_999), "0:05");
	assert.equal(formatRemaining(5_000), "0:05");
});

const MARKS: [ms: number, want: string][] = [
	[61_000, "1:01"],
	[90_000, "1:30"],
	[119_000, "1:59"],
	[120_000, "2:00"],
	[599_000, "9:59"],
	[600_000, "10:00"],
	[3_540_000, "59:00"],
	[3_599_000, "59:59"],
	[3_600_000, "1:00:00"],
	[3_600_001, "1:00:01"],
	[3_660_000, "1:01:00"],
	[36_610_000, "10:10:10"],
	[360_000_000, "100:00:00"],
];
for (const [ms, want] of MARKS) {
	test(`format ${ms}ms → ${want}`, () => {
		assert.equal(formatRemaining(ms), want);
	});
}

// ---- Clamping ----

for (const ms of [0, -1, -5_000, -3_600_000]) {
	test(`negative time (${ms}ms) clamps to 0:00`, () => {
		assert.equal(formatRemaining(ms), "0:00");
	});
}

// ---- stateOf: ratio sweep, both ttls ----

const TTLS = [5 * 60_000, 60 * 60_000, 60_000, 3_600_000];
for (const ttl of TTLS) {
	for (let pct = 0; pct <= 100; pct += 5) {
		const msLeft = (ttl * pct) / 100;
		const want = msLeft <= 0 ? "cold" : pct >= 50 ? "warm" : pct >= 10 ? "cooling" : "cold";
		test(`state at ${pct}% of ${ttl / 60_000}m ttl → ${want}`, () => {
			assert.equal(stateOf(msLeft, ttl), want);
		});
	}
}

test("the exact boundaries: 50% still warm, 10% still cooling, under both cold", () => {
	assert.equal(stateOf(FIVE_MIN * 0.5, FIVE_MIN), "warm");
	assert.equal(stateOf(FIVE_MIN * 0.5 - 1, FIVE_MIN), "cooling");
	assert.equal(stateOf(FIVE_MIN * 0.1, FIVE_MIN), "cooling");
	assert.equal(stateOf(FIVE_MIN * 0.1 - 1, FIVE_MIN), "cold");
});

test("a ttl of zero is cold at any leftover", () => {
	assert.equal(stateOf(1, 0), "cold");
	assert.equal(stateOf(0, 0), "cold");
});

// ---- parseTtl: valid ----

const VALID: [arg: string, ms: number][] = [
	["05m", 300_000],
	["1m", 60_000],
	["5m", 300_000],
	["30m", 1_800_000],
	["59m", 3_540_000],
	["1h", 3_600_000],
	["2h", 7_200_000],
	["12h", 43_200_000],
];
for (const [arg, ms] of VALID) {
	test(`parse ${arg} → ${ms}`, () => {
		assert.equal(parseTtl(arg), ms);
	});
}

// ---- parseTtl: invalid (the traps) ----

const INVALID: string[] = [
	"",
	"  ",
	"m",
	"5",
	"5x",
	"five",
	"m5",
	"5 m",
	"-5m",
	"0m",
	"0h",
	"5M",
	"5H",
	"1.5h",
	"∞",
	"5min",
];
for (const arg of INVALID) {
	test(`parse rejects ${JSON.stringify(arg)}`, () => {
		assert.equal(parseTtl(arg), undefined);
	});
}

test("parse handles undefined and null-ish input", () => {
	assert.equal(parseTtl(undefined), undefined);
});
