import { test } from "node:test";
import assert from "node:assert/strict";
import { alreadyStructured, gapQuestions, isCommand, looksLong, shouldIntercept } from "../src/classify.ts";

const long = (words: number) => Array.from({ length: words }, (_, i) => `w${i}`).join(" ");
const kinds = (text: string) => gapQuestions(text).map((q) => q.kind);

// ---- looksLong ----

test("a prompt under 25 words is not long", () => {
	assert.equal(looksLong("fix the bug in main.ts"), false);
	assert.equal(looksLong(long(24)), false);
});

test("a prompt of 25 words or more is long", () => {
	assert.equal(looksLong(long(25)), true);
	assert.equal(looksLong(long(120)), true);
});

test("word counting ignores extra whitespace and newlines", () => {
	assert.equal(looksLong("a  b\tc\n".repeat(9).trim()), true, "27 words via repeats");
	assert.equal(looksLong(""), false);
	assert.equal(looksLong("   "), false);
});

// ---- isCommand ----

test("slash commands are commands, with or without leading space", () => {
	assert.equal(isCommand("/compaction"), true);
	assert.equal(isCommand("  /model"), true);
	assert.equal(isCommand("/b"), true);
});

test("plain prompts and sentences are not commands", () => {
	assert.equal(isCommand("fix /the/bug path"), false);
	assert.equal(isCommand(""), false);
	assert.equal(isCommand("write /tmp/out.md"), false);
});

// ---- alreadyStructured ----

test("a prompt that already carries the four-part headers is left alone", () => {
	assert.equal(alreadyStructured("## The job\nfix it"), true);
	assert.equal(alreadyStructured("some text\n## Done means\nall green"), true);
	assert.equal(alreadyStructured("## Guardrails\nnone"), true);
});

test("a plain prompt is not structured", () => {
	assert.equal(alreadyStructured("please fix the login bug and write tests"), false);
	assert.equal(alreadyStructured(""), false);
});

// ---- gapQuestions: one keyed question per missing signal ----

test("a prompt with no signals asks scope, why, and guardrails (done is fourth, cut at three)", () => {
	assert.deepEqual(kinds(long(30)), ["scope", "why", "guardrails"]);
});

test("at most three questions ever, and the missing signals decide which", () => {
	assert.ok(gapQuestions(long(200)).length <= 3);
});

test("a prompt naming files skips the scope question", () => {
	assert.ok(!kinds(`${long(30)} in src/main.ts`).includes("scope"));
	assert.deepEqual(kinds(`${long(30)} in src/main.ts`), ["why", "guardrails", "done"]);
});

test("a prompt with a why signal skips the why question", () => {
	assert.ok(!kinds(`${long(30)} so that users can log in`).includes("why"));
});

test("a prompt with guardrails skips the guardrails question", () => {
	assert.ok(!kinds(`${long(30)} but don't touch the public API`).includes("guardrails"));
});

test("a prompt with a done signal skips the done question", () => {
	assert.ok(!kinds(`${long(30)} tests must pass`).includes("done"));
});

test("a prompt answering everything gets no questions", () => {
	const text = `${long(25)} in src/auth.ts because login is broken, but don't break sessions, tests must pass`;
	assert.deepEqual(gapQuestions(text), []);
});

test("every question carries a plain-words string", () => {
	for (const q of gapQuestions(long(30))) {
		assert.ok(typeof q.question === "string" && q.question.length > 10);
	}
});

test("file detection knows paths, extensions, quotes, and file words", () => {
	for (const tail of ["in src/main.ts", "the README.md file", 'the "login page"', "the auth folder", "the utils directory"]) {
		assert.ok(!kinds(`${long(30)} ${tail}`).includes("scope"), tail);
	}
});

test("done detection knows so-that, results, and outputs", () => {
	for (const tail of ["so that it passes", "write the result to out.md", "the output should be json", "tests must pass"]) {
		assert.ok(!kinds(`${long(30)} ${tail}`).includes("done"), tail);
	}
});

test("guardrail detection knows don't, avoid, keep, and never", () => {
	for (const tail of ["don't rename things", "avoid new deps", "keep the api stable", "never touch ci"]) {
		assert.ok(!kinds(`${long(30)} ${tail}`).includes("guardrails"), tail);
	}
});

// ---- shouldIntercept: the gate ----

test("a long loose prompt is intercepted", () => {
	assert.equal(shouldIntercept(long(30)), true);
});

test("short prompts, commands, and already-structured prompts pass through", () => {
	assert.equal(shouldIntercept("fix the bug"), false);
	assert.equal(shouldIntercept(`/model ${long(30)}`), false);
	assert.equal(shouldIntercept(`## The job\n${long(30)}`), false);
	assert.equal(shouldIntercept(""), false);
});
