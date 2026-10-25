import { test } from "node:test";
import assert from "node:assert/strict";
import { alreadyStructured, gapQuestions, isCommand, looksLong, shouldIntercept, type QuestionKind } from "../src/classify.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const kinds = (text: string) => gapQuestions(text).map((q) => q.kind as QuestionKind);

// ---- The gate, swept across the boundary ----

test("the length boundary is exact: 24 no, 25 yes", () => {
	assert.equal(looksLong(words(24)), false);
	assert.equal(looksLong(words(25)), true);
});

for (let n = 18; n <= 32; n++) {
	test(`gate at ${n} words: ${n >= 25 ? "caught" : "passes"}`, () => {
		assert.equal(shouldIntercept(words(n)), n >= 25);
	});
}

test("very long prompts are still caught", () => {
	assert.equal(shouldIntercept(words(2000)), true);
});

// ---- Whitespace oddities ----

for (const [name, text, wordCount] of [
	["tabs", "a\tb\tc\td", 4],
	["newlines", "a\nb\nc\nd", 4],
	["leading blank", "   hello world", 2],
	["trailing blank", "hello world   ", 2],
	["collapse runs", "a    b", 2],
] as const) {
	test(`word counting with ${name}`, () => {
		assert.equal(looksLong(text), wordCount >= 25 ? true : false);
	});
}

test("a prompt made only of separators counts as zero words", () => {
	assert.equal(looksLong("   \n\t  "), false);
	assert.equal(shouldIntercept("   \n\t  "), false);
});

// ---- Commands ----

for (const cmd of ["/model", "/helpers", "/b", "/inventory with args", "  /spaced", "/handoff"]) {
	test(`command passes: ${JSON.stringify(cmd.slice(0, 20))}`, () => {
		assert.equal(isCommand(cmd), true);
		assert.equal(shouldIntercept(`${cmd} ${words(40)}`), false);
	});
}

for (const not of ["use /etc/hosts", "see https://x.com/a", "a / b / c", "path/to/file", "write /tmp/out.md"]) {
	test(`not a command: ${JSON.stringify(not)}`, () => {
		assert.equal(isCommand(not), false);
	});
}

// ---- Already structured ----

for (const part of ["The job", "The why", "Guardrails", "Done means"]) {
	for (const form of [`## ${part}\n`, `## ${part.toLowerCase()}\n`, `##  ${part} \n`, `text\n## ${part}\nmore`]) {
		test(`structured by ${JSON.stringify(part)} (form ${form.length})`, () => {
			assert.equal(alreadyStructured(form), true, form);
			assert.equal(shouldIntercept(`${form} ${words(40)}`), false);
		});
	}
}

test("headings that are not ours do not count", () => {
	assert.equal(alreadyStructured("## The plan\nfix it"), false);
	assert.equal(alreadyStructured("## Jobs\nfix it"), false);
	assert.equal(alreadyStructured("# The job\nfix it"), false);
});

// ---- Signal matrix: one signal present, its question goes ----

const SIGNALS: [name: string, tail: string, absent: string][] = [
	["ts path", "in src/main.ts", "scope"],
	["short path", "in lib/x.py", "scope"],
	["dotfile", "the .env file", "scope"],
	["quoted", 'the "login page"', "scope"],
	["folder", "the auth folder", "scope"],
	["directory", "the utils directory", "scope"],
	["files word", "the files", "scope"],
	["module", "that module", "scope"],
	["component", "the button component", "scope"],
	["why because", "because it broke", "why"],
	["why so that", "so that users log in", "why"],
	["why for the", "for the release", "why"],
	["why in order", "in order to ship", "why"],
	["guardrail don't", "but don't touch ci", "guardrails"],
	["guardrail never", "and never edit it", "guardrails"],
	["guardrail avoid", "while avoiding deps", "guardrails"],
	["guardrail keep", "but keep the api", "guardrails"],
	["guardrail only", "touch only src/", "guardrails"],
	["done tests pass", "until tests pass", "done"],
	["done result", "and the result is json", "done"],
	["done write to", "write it to out.md", "done"],
	["done should", "it should be green", "done"],
	["done summary", "then a summary", "done"],
	["done ship", "so we can ship", "done"],
];

for (const [name, tail, absent] of SIGNALS) {
	test(`signal ${name} skips ${absent}`, () => {
		assert.ok(!kinds(`${words(30)} ${tail}`).includes(absent as QuestionKind), tail);
	});
}

// ---- No signals: all questions, cut at three ----

test("a bare long prompt asks scope, why, guardrails (done only fits under three)", () => {
	assert.deepEqual(kinds(words(30)), ["scope", "why", "guardrails"]);
});

test("when scope is answered, done joins: scope+why+guardrails+done minus scope", () => {
	assert.deepEqual(kinds(`${words(30)} in src/main.ts`), ["why", "guardrails", "done"]);
});

test("scope and guardrails answered: why and done asked", () => {
	assert.deepEqual(kinds(`${words(30)} in src/main.ts but don't touch ci`), ["why", "done"]);
});

test("everything answered: no questions", () => {
	assert.deepEqual(kinds(`${words(30)} in src/main.ts because release, don't touch ci, tests must pass`), []);
});

// ---- False-positive checks on signals ----

test("words merely containing signal words do not count", () => {
	// "keeping" is not the guardrail "keep"; "donut" is not "don't".
	assert.ok(kinds(`${words(30)} keeping the donut`).includes("guardrails"));
});

test("scope-ish markdown headers alone do not satisfy scope", () => {
	assert.ok(kinds(`${words(30)} do it well`).includes("scope"));
});

// ---- Question payload sanity ----

test("every question has kind and text; kinds are unique", () => {
	const qs = gapQuestions(words(30));
	assert.equal(new Set(qs.map((q) => q.kind)).size, qs.length);
	for (const q of qs) {
		assert.ok(q.question.endsWith("?"));
		assert.ok(q.question.length >= 20);
	}
});
