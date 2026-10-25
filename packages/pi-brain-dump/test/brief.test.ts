import { test } from "node:test";
import assert from "node:assert/strict";
import { FOUR_PARTS, buildBrief } from "../src/brief.ts";
import { alreadyStructured } from "../src/classify.ts";

const LONG = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");

test("the four parts, in the Claude mod's order: job, why, guardrails, done means", () => {
	assert.deepEqual(FOUR_PARTS, ["The job", "The why", "Guardrails", "Done means"]);
});

test("the brief keeps the original prompt as the job, verbatim", () => {
	const brief = buildBrief("  fix the login bug  ");
	assert.ok(brief.startsWith("## The job\nfix the login bug\n"));
});

test("every part carries its header, and none are missing", () => {
	const brief = buildBrief(LONG, { why: "for the release", guardrails: "don't touch the API", done: "tests pass" });
	for (const part of FOUR_PARTS) assert.ok(brief.includes(`## ${part}`));
	assert.ok(brief.indexOf("## The job") < brief.indexOf("## The why"));
	assert.ok(brief.indexOf("## The why") < brief.indexOf("## Guardrails"));
	assert.ok(brief.indexOf("## Guardrails") < brief.indexOf("## Done means"));
});

test("answers land in their own sections, whatever order they were asked", () => {
	const brief = buildBrief(LONG, { why: "because the release blocks on it", guardrails: "keep changes under src/auth", done: "a green test run" });
	assert.ok(brief.includes("## The why\nbecause the release blocks on it"));
	assert.ok(brief.includes("## Guardrails\nkeep changes under src/auth"));
	assert.ok(brief.includes("## Done means\na green test run"));
});

test("a scope answer joins the job as a Scope line", () => {
	const brief = buildBrief(LONG, { scope: "src/auth only" });
	assert.ok(brief.includes("fix this\n\nScope: src/auth only") || brief.match(/## The job\n[\s\S]+\n\nScope: src\/auth only/));
	assert.ok(brief.indexOf("Scope: src/auth only") < brief.indexOf("## The why"));
});

test("no scope answer adds no Scope line", () => {
	const brief = buildBrief(LONG);
	assert.equal(brief.includes("Scope:"), false);
});

test("skipped answers get honest fallbacks, not empty sections", () => {
	const brief = buildBrief(LONG);
	assert.ok(brief.includes("## The why\nNot specified — use your judgment."));
	assert.ok(brief.includes("## Guardrails\nNone given — nothing is off limits."));
	assert.ok(brief.includes("## Done means\nNot specified — propose what done looks like."));
});

test("answers are trimmed and collapsed to one line", () => {
	const brief = buildBrief(LONG, { why: "  because\nof\tthe  release  " });
	assert.ok(brief.includes("## The why\nbecause of the release"));
});

test("the brief is always structured: the classifier leaves it alone next time", () => {
	assert.equal(alreadyStructured(buildBrief(LONG)), true);
});

test("a long answer keeps its text (the user said it, the brief repeats it)", () => {
	const answer = "because ".repeat(40).trim();
	assert.ok(buildBrief(LONG, { why: answer }).includes(answer));
});

test("a job with trailing newlines does not produce triple blanks", () => {
	assert.equal(buildBrief(`${LONG}\n\n`).includes("\n\n\n"), false);
});
