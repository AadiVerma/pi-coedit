import { test } from "node:test";
import assert from "node:assert/strict";
import { isCorrection, suggestRule } from "../src/correct.ts";

// ---- isCorrection ----

test("outright corrections are corrections", () => {
	for (const text of [
		"no, use vite not webpack",
		"that's wrong, the config lives in src/",
		"actually the tests run with bun",
		"I said use pnpm, not npm",
		"wrong file — it's in the packages folder",
		"stop, you're editing the wrong branch",
		"undo that change",
		"revert the last edit",
		"not like that",
	]) {
		assert.equal(isCorrection(text), true, text);
	}
});

test("plain instructions and questions are not corrections", () => {
	for (const text of [
		"now also add tests",
		"what does this function do?",
		"looks good, ship it",
		"thanks!",
		"can you make the button blue?",
		"continue",
	]) {
		assert.equal(isCorrection(text), false, text);
	}
});

test("empty and command input are not corrections", () => {
	assert.equal(isCorrection(""), false);
	assert.equal(isCorrection("   "), false);
	assert.equal(isCorrection("/model"), false);
});

test("casing does not matter", () => {
	assert.equal(isCorrection("NO — use pnpm"), true);
	assert.equal(isCorrection("Actually it's bun"), true);
});

test("a bare 'no' without a follow-up is still a correction", () => {
	assert.equal(isCorrection("no"), true);
});

// ---- suggestRule ----

test("a correction with the rule spelled out extracts it", () => {
	assert.equal(suggestRule("no, use pnpm for everything"), "Use pnpm for everything.");
	assert.equal(suggestRule("that's wrong — the config lives in src/"), "The config lives in src/.");
});

test("an after-no clause becomes the rule; the interjection is dropped", () => {
	assert.equal(suggestRule("no! always run tests before committing"), "Always run tests before committing.");
});

test("a correction without a rule candidate suggests asking the model's correction verbatim", () => {
	assert.equal(suggestRule("revert the last edit"), "When asked, revert instead of editing on.");
});

test("the rule is one line, trimmed, and capitalized", () => {
	const rule = suggestRule("actually   use   bun\nfor tests  ");
	assert.equal(rule, "Use bun for tests.");
	assert.ok(!rule.includes("\n"));
});

test("rules end with a period", () => {
	assert.ok(suggestRule("no, never touch ci").endsWith("."));
});
