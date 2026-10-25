import { test } from "node:test";
import assert from "node:assert/strict";
import { FOUR_PARTS, buildBrief, type BriefAnswers } from "../src/brief.ts";
import { alreadyStructured } from "../src/classify.ts";

const LONG = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
const ANS: (keyof BriefAnswers)[] = ["scope", "why", "guardrails", "done"];

// ---- Every combination of provided/missing answers (2^4) ----

for (let mask = 0; mask < 16; mask++) {
	const answers: BriefAnswers = {};
	const provided: (keyof BriefAnswers)[] = [];
	for (const [i, key] of ANS.entries()) {
		if (mask & (1 << i)) {
			answers[key] = `answer for ${key}`;
			provided.push(key);
		}
	}
	test(`brief with [${provided.join(", ") || "nothing"}]`, () => {
		const brief = buildBrief(LONG, answers);
		// Structure: all four headers, in order, always.
		for (const part of FOUR_PARTS) assert.ok(brief.includes(`## ${part}`));
		let at = -1;
		for (const part of FOUR_PARTS) {
			const next = brief.indexOf(`## ${part}`);
			assert.ok(next > at, `${part} in order`);
			at = next;
		}
		// Content: provided answers appear; missing ones get fallbacks.
		const SECTION: Record<keyof BriefAnswers, string> = {
			scope: "Scope",
			why: "The why",
			guardrails: "Guardrails",
			done: "Done means",
		};
		for (const key of provided) {
			if (key === "scope") assert.ok(brief.includes("Scope: answer for scope"));
			else assert.ok(brief.includes(`## ${SECTION[key]}\nanswer for ${key}`));
		}
		if (!provided.includes("why")) assert.ok(brief.includes("Not specified — use your judgment."));
		if (!provided.includes("guardrails")) assert.ok(brief.includes("None given — nothing is off limits."));
		if (!provided.includes("done")) assert.ok(brief.includes("Not specified — propose what done looks like."));
		// And it is structured, so the gate never re-catches it.
		assert.equal(alreadyStructured(brief), true);
	});
}

// ---- Whitespace and shape of answers ----

for (const [name, raw, want] of [
	["multiline", "  because\nof\tthings  ", "because of things"],
	["surrounding spaces", "  keep it small  ", "keep it small"],
	["tabs only", "\t\t", ""],
	["unicode", "使用 bun ✓", "使用 bun ✓"],
	["very long", "x".repeat(500), "x".repeat(500)],
] as const) {
	test(`answer normalization: ${name}`, () => {
		const brief = buildBrief(LONG, { why: raw });
		if (want === "") assert.ok(brief.includes("Not specified"), "blank falls back");
		else assert.ok(brief.includes(want), `${name} normalized`);
	});
}

// ---- The job section ----

test("the job keeps internal newlines but loses outer whitespace", () => {
	const brief = buildBrief("  line one\nline two  ");
	assert.ok(brief.startsWith("## The job\nline one\nline two\n"));
});

test("an empty prompt still produces a valid skeleton", () => {
	const brief = buildBrief("");
	assert.ok(brief.startsWith("## The job\n\n"));
	assert.ok(brief.includes("## Done means"));
});

test("a job containing our own headers still builds a parseable brief", () => {
	// The gate refuses such prompts, so this is defense in depth: whatever the job,
	// the result still parses as structured.
	const brief = buildBrief("## The job\nnested");
	assert.equal(alreadyStructured(brief), true);
	assert.ok(brief.includes("## Done means"));
});

test("markdown inside the job survives verbatim", () => {
	const job = "fix the **login** flow:\n- sso\n- mfa\n";
	const brief = buildBrief(job);
	assert.ok(brief.includes(job.trim()));
});

// ---- Scope line ----

test("scope lands under the job with a blank line between", () => {
	const brief = buildBrief(LONG, { scope: "src/auth only" });
	assert.ok(/\n\nScope: src\/auth only\n\n## The why/.test(brief));
});

test("a blank scope answer adds no Scope line", () => {
	assert.ok(!buildBrief(LONG, { scope: "   " }).includes("Scope:"));
});

// ---- Idempotence and invariants ----

test("every brief ends with a newline and has no triple blanks", () => {
	for (const brief of [buildBrief(LONG), buildBrief("x"), buildBrief(LONG, { scope: "a", why: "b", guardrails: "c", done: "d" })]) {
		assert.ok(brief.endsWith("\n"));
		assert.ok(!brief.includes("\n\n\n"));
	}
});

test("answers never leak into the wrong section", () => {
	const brief = buildBrief(LONG, { why: "WHYMARK", guardrails: "GMARK", done: "DMARK" });
	const why = brief.split("## The why")[1].split("##")[0];
	const guard = brief.split("## Guardrails")[1].split("##")[0];
	const done = brief.split("## Done means")[1];
	assert.ok(why.includes("WHYMARK") && !why.includes("GMARK") && !why.includes("DMARK"));
	assert.ok(guard.includes("GMARK") && !guard.includes("WHYMARK"));
	assert.ok(done.includes("DMARK") && !done.includes("WHYMARK"));
});
