import { test } from "node:test";
import assert from "node:assert/strict";
import { isCorrection, suggestRule } from "../src/correct.ts";

// ---------------------------------------------------------------------------
// Corrections: things people actually type when the agent got it wrong.
// ---------------------------------------------------------------------------

const CORRECTIONS: string[] = [
	"no",
	"no.",
	"no!",
	"no,",
	"No",
	"NO",
	"no use vite",
	"no, use vite not webpack",
	"no! stop",
	"no wait, use pnpm",
	"no no, the other file",
	"nope, that broke it",
	"nah, revert it",
	"not that one",
	"not like that",
	"not quite",
	"not what I asked for",
	"wrong file",
	"wrong, try again",
	"wrong!",
	"that's wrong",
	"that's not it",
	"that's not what I said",
	"that's incorrect",
	"Thats wrong",
	"That is not right",
	"actually it's bun",
	"Actually, use bun",
	"actually the config lives in src/",
	"actually no",
	"i said use pnpm",
	"I said tests, not docs",
	"I told you src not lib",
	"I asked for typescript",
	"you broke the build",
	"you're editing the wrong branch",
	"you should have used pnpm",
	"you were supposed to wait",
	"stop",
	"stop, undo that",
	"stop it",
	"undo that",
	"undo the last edit",
	"undo!",
	"revert",
	"revert that",
	"revert the last edit",
	"revert it now",
	"no, undo",
	"don't do that",
	"don't touch ci",
	"do not delete the file",
	"no, never touch the lockfile",
	"no — use the other function",
	"wrong folder, it's packages/ not src/",
	"no. the tests must run first",
	"Correction: the port is 3000",
	"hold on, wrong approach",
	"wait no, wrong file",
	"no,\nuse pnpm",
	"  no, use pnpm",
	"no use the agent tool",
	"not pnpm, bun",
	"that's the wrong model",
	"you missed the point",
	"you misunderstood",
	"that's backwards",
	"that's inverted",
	"no, other direction",
	"não, use pnpm",
	"start over",
	"go back",
	"try again but with bun",
	"again, but keep the types",
];

for (const text of CORRECTIONS) {
	test(`correction: ${JSON.stringify(text.slice(0, 40))}`, () => {
		assert.equal(isCorrection(text), true);
	});
}

// ---------------------------------------------------------------------------
// Not corrections: offers here would be noise. (These sting: "pls" praise, "no?" questions.)
// ---------------------------------------------------------------------------

const NOT: string[] = [
	"now add tests",
	"now also add a footer",
	"next, do the docs",
	"also fix the lint",
	"and then commit",
	"continue",
	"continue with the plan",
	"go on",
	"keep going",
	"ok",
	"okay",
	"great",
	"looks good",
	"perfect",
	"nice work",
	"thanks!",
	"thank you",
	"awesome, ship it",
	"yes",
	"yep do that",
	"sure",
	"please proceed",
	"what does this function do?",
	"why did you edit that?",
	"can you make it blue?",
	"could you add types?",
	"would you check the build?",
	"is it done?",
	"are we green?",
	"how long will this take?",
	"no?",
	"no worries if not",
	"note: the port is 3000",
	"now, about the config",
	"nothing yet",
	"/model",
	"/model claude",
	"not only that, also add docs",
	"another thing: the footer",
	"additionally write tests",
	"importantly, keep it small",
	"nothing was written yet",
	"know anything about bun?",
	"notable: the api changed",
	"normalize the names",
	"no objections, continue",
];

for (const text of NOT) {
	test(`not a correction: ${JSON.stringify(text.slice(0, 40))}`, () => {
		assert.equal(isCorrection(text), false);
	});
}

// ---------------------------------------------------------------------------
// Rule extraction: the suggestion must be a followable one-liner.
// ---------------------------------------------------------------------------

const RULES: [input: string, rule: string][] = [
	["no, use pnpm for everything", "Use pnpm for everything."],
	["no! always run tests before committing", "Always run tests before committing."],
	["that's wrong — the config lives in src/", "The config lives in src/."],
	// Deixis-led fragments ("it's bun") are not durable rules: fallback. Verbs are.
	["actually it's bun", "When asked, revert instead of editing on."],
	["I said use pnpm", "Use pnpm."],
	["don't touch ci", "Don't touch ci."],
	["never edit the lockfile by hand", "Never edit the lockfile by hand."],
	["do not delete the file", "Do not delete the file."],
	["not pnpm, bun", "Not pnpm, bun."],
	["no, keep changes under src/auth", "Keep changes under src/auth."],
	["wrong, prefer edit over write", "Prefer edit over write."],
	["no avoid new dependencies", "Avoid new dependencies."],
];

for (const [input, rule] of RULES) {
	test(`rule from: ${JSON.stringify(input.slice(0, 40))}`, () => {
		assert.equal(suggestRule(input), rule);
	});
}

test("a correction pointing only at the previous change falls back to a generic rule", () => {
	for (const input of ["revert the last edit", "undo that", "undo the last edit", "the last change was wrong — redo it"]) {
		const rule = suggestRule(input);
		assert.ok(rule.length > 10, `${input} → a real rule, not empty`);
		assert.ok(!/^(The|This) (last|previous)/i.test(rule), `${input} → not anchored to the moment`);
	}
});

test("every suggestion from the correction corpus is a clean one-liner", () => {
	for (const text of CORRECTIONS) {
		const rule = suggestRule(text);
		assert.ok(rule.length >= 8 && !rule.includes("\\n"), text);
		assert.ok(/[.]$/.test(rule), `${text} → "${rule}" ends with a period`);
	}
});

test("unicode and emoji in corrections survive into the rule", () => {
	const rule = suggestRule("no, use 字体.ts ✓");
	assert.ok(rule.includes("字体.ts"));
});
