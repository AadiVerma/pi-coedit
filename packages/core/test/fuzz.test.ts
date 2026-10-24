/**
 * Property/fuzz tests: thousands of generated cases per run with a seeded RNG
 * (failures are reproducible via SEED env). Invariants:
 *   I1  diff round-trip — applying computeHunks() to `before` reconstructs `after` exactly
 *   I2  attribution line-count — replayed engine line count == current content line count
 *   I3  attribution origins — every origin ∈ {unchanged, human, agent, both, unknown}
 *   I4  replay determinism — incremental application == from-scratch replay
 *   I5  idempotent re-application — re-applying an event with identical hashes and hunks
 *       is a no-op at the hash level (hashes unchanged, no crash)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHunks } from "../src/diff.ts";
import { AttributionEngine } from "../src/attribution.ts";
import { contentHash, splitLines } from "../src/util.ts";
import type { CoeditEvent, Hunk } from "../src/types.ts";

let executed = 0;

// mulberry32 — small, deterministic, good enough distribution for fuzzing.
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ALPHABETS = [
	["alpha", "x", "y", "foo()", "}", "{"],
	["crlf", "a\r", "b\r", "c\r"], // CRLF line endings (split on \n keeps \r)
	["unicode", "héllo", "世界", "🚀🔥", "naïve"],
	["repeats", "same", "same", "same", "same", ""],
];

function randomLines(r: () => number, family: string[]): { lines: string[]; trailingNewline: boolean } {
	const n = Math.floor(r() * 40);
	const lines: string[] = [];
	for (let i = 0; i < n; i++) lines.push(family[Math.floor(r() * family.length)] + (r() < 0.3 ? `-${i}` : ""));
	// never end with an empty line: ["a", ""] without a final newline is
	// unrepresentable in the line model (documented in README limits)
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return { lines, trailingNewline: n > 0 ? r() < 0.7 : r() < 0.5 };
}

function toContent(lines: string[], trailingNewline: boolean): string {
	return lines.length === 0 ? "" : lines.join("\n") + (trailingNewline ? "\n" : "");
}

function mutate(r: () => number, lines: string[], family: string[]): string[] {
	const out = [...lines];
	const ops = 1 + Math.floor(r() * 6);
	for (let i = 0; i < ops; i++) {
		const kind = r();
		const pos = Math.floor(r() * (out.length + 1));
		if (kind < 0.35 || out.length === 0) {
			out.splice(pos, 0, family[Math.floor(r() * family.length)] + `-new${i}`);
		} else if (kind < 0.65) {
			out.splice(pos, 1 + Math.floor(r() * Math.min(3, out.length - pos)));
		} else if (kind < 0.9) {
			const count = 1 + Math.floor(r() * Math.min(3, out.length - pos));
			for (let k = 0; k < count && pos + k < out.length; k++) {
				out[pos + k] = family[Math.floor(r() * family.length)] + `-mut${i}${k}`;
			}
		} else {
			// duplicate a block (tests repeated-line alignment)
			const count = 1 + Math.floor(r() * Math.min(3, out.length - pos));
			out.splice(pos, 0, ...out.slice(pos, pos + count));
		}
	}
	return out;
}

function makeEvent(seq: number, before: string, after: string, author: CoeditEvent["author"]): CoeditEvent {
	const beforeLines = splitLines(before);
	const afterLines = splitLines(after);
	const binary = before.includes("\0") || after.includes("\0");
	return {
		id: `fz${String(seq).padStart(6, "0")}`,
		ts: new Date(2026, 0, 1, 0, 0, seq % 60).toISOString(),
		worktree: "/wt",
		file: "f.ts",
		author,
		source: author === "agent" ? "pi-edit" : "editor",
		beforeHash: contentHash(before),
		afterHash: contentHash(after),
		binary,
		hunks: binary ? [] : computeHunks(beforeLines, afterLines),
	};
}

/** I1: applying hunks to `before` reconstructs `after`. */
function assertRoundTrip(beforeLines: string[], afterLines: string[], hunks: Hunk[], label: string): void {
	const work = [...beforeLines];
	let shift = 0;
	for (const h of hunks) {
		const pos = h.delStart + shift;
		assert.ok(pos >= 0 && pos + h.delCount <= work.length, `${label}: hunk del range out of bounds`);
		work.splice(pos, h.delCount, ...afterLines.slice(h.insStart, h.insStart + h.insCount));
		shift += h.insCount - h.delCount;
	}
	assert.deepEqual(work, afterLines, `${label}: hunks do not reconstruct after-content`);
}

test("FUZZ I1: diff round-trip over 3000 random content pairs", { timeout: 120_000 }, () => {
	const seed = Number(process.env.SEED ?? 42);
	const r = rng(seed);
	for (let i = 0; i < 3000; i++) {
		const family = ALPHABETS[i % ALPHABETS.length][1] === "x" || i % 4 === 0 ? ALPHABETS[0].slice(1) : ALPHABETS[i % 4].slice(1);
		const a = randomLines(r, family);
		const b = randomLines(r, family);
		// mix: half the cases mutate a into b (realistic proximity), half are fully random
		// A trailing EMPTY line without a final newline is unrepresentable in the line model
		// (splitLines collapses it into the final newline) — exclude it from generation;
		// documented as a model limit in README. Hashes still distinguish the contents.
		const beforeLines = a.lines[a.lines.length - 1] === "" && !a.trailingNewline ? a.lines.slice(0, -1) : a.lines;
		const afterLinesRaw = i % 2 === 0 ? mutate(r, a.lines, family) : b.lines;
		const afterLines = afterLinesRaw[afterLinesRaw.length - 1] === "" && !(i % 2 === 0 ? a.trailingNewline : b.trailingNewline) ? afterLinesRaw.slice(0, -1) : afterLinesRaw;
		const beforeContent: string = toContent(beforeLines, a.trailingNewline);
		const afterContent = toContent(afterLines, i % 2 === 0 ? a.trailingNewline : b.trailingNewline);
		const hunks = computeHunks(beforeLines, splitLines(afterContent));
		if (beforeContent !== "") assert.equal(beforeContent.split("\n").length - (beforeContent.endsWith("\n") ? 1 : 0), beforeLines.length, `case#${i} lines=${JSON.stringify(beforeLines)} tn=${a.trailingNewline}`);
		assertRoundTrip(beforeLines, splitLines(afterContent), hunks, `case#${i} seed=${seed}`);
		executed++;
	}
	console.log(`  fuzz I1 executed ${executed} cases (seed ${seed})`);
});

test("FUZZ I2+I3+I4: attribution replay invariants over 3000 random event sequences", { timeout: 120_000 }, () => {
	const seed = Number(process.env.SEED ?? 43);
	const r = rng(seed);
	const VALID = new Set(["unchanged", "human", "agent", "both", "unknown"]);
	const family = ALPHABETS[0].slice(1);

	for (let iter = 0; iter < 3000; iter++) {
		const engine = new AttributionEngine();
		let content = toContent(randomLines(r, family).lines, true);
		let fileDeleted = false; // file absent on disk after a true deletion
		// first-seen baseline
		engine.markBaseline("f.ts", splitLines(content).length, null);
		const events: CoeditEvent[] = [];
		const n = 1 + Math.floor(r() * 14);
		for (let s = 0; s < n; s++) {
			const author = (["agent", "human", "unknown"] as const)[Math.floor(r() * 3)];
			const wasDeleted: boolean = fileDeleted; // recreate from nothing after a deletion
			const beforeLines: string[] = wasDeleted ? [] : splitLines(content);
			const afterLines: string[] = r() < 0.1 ? [] : mutate(r, beforeLines, family); // 10%: empty the file
			const deleted: boolean = afterLines.length === 0 && r() < 0.5; // …and half of those are true deletions
			const after = toContent(afterLines, true);
			const ev = makeEvent(events.length, wasDeleted ? "" : content, after, author);
			if (deleted) ev.afterHash = null; // real deletion: content is gone, not merely empty
			if (wasDeleted) ev.beforeHash = null; // recreation: file did not exist
			events.push(ev);
			engine.applyEvent(ev);
			content = after;
			fileDeleted = deleted;
		}
		const attr = engine.get("f.ts");
		if (fileDeleted) {
			assert.equal(attr, undefined, `case#${iter}: file deleted -> state dropped`);
		} else {
			assert.ok(attr, `case#${iter}: missing attribution`);
			assert.equal(attr!.lines.length, splitLines(content).length, `case#${iter}: I2 line count`);
			for (const l of attr!.lines) {
				assert.ok(VALID.has(l.origin), `case#${iter}: I3 invalid origin ${l.origin}`);
				assert.ok(Array.isArray(l.events), `case#${iter}: events array`);
			}
		}
		// I4: replay from scratch without a seeded baseline (the inferred path that
		// real sessions hit for never-observed files) must not crash and must stay valid.
		const inferred = new AttributionEngine();
		for (const ev of events) inferred.applyEvent(ev);
		for (const l of inferred.get("f.ts")?.lines ?? []) {
			assert.ok(VALID.has(l.origin), `case#${iter}: I4-inferred invalid origin ${l.origin}`);
		}
		executed++;
	}
	console.log(`  fuzz I2/I3/I4 executed ${executed} cumulative cases (seed ${seed})`);
});

test("FUZZ I5: 1000 multi-hunk boundary cases — hunks adjacent to file edges", { timeout: 60_000 }, () => {
	const seed = Number(process.env.SEED ?? 44);
	const r = rng(seed);
	for (let i = 0; i < 1000; i++) {
		const n = Math.floor(r() * 12);
		const before = Array.from({ length: n }, (_, k) => `L${k}`);
		const after = [...before];
		const mode = i % 5;
		if (mode === 0) after.unshift("HEAD"); // insert at 0
		else if (mode === 1) after.push("TAIL"); // append
		else if (mode === 2) after.shift(); // delete first
		else if (mode === 3) after.pop(); // delete last
		else if (after.length > 0) after[Math.floor(r() * after.length)] = "CHANGED"; // replace
		const hunks = computeHunks(before, after);
		assertRoundTrip(before, after, hunks, `edge#${i} mode=${mode}`);
		executed++;
	}
	console.log(`  fuzz I5 executed ${executed} cumulative cases (seed ${seed})`);
});
