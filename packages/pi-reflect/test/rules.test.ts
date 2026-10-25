import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRule, readRules } from "../src/rules.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "reflect-"));

test("a fresh AGENTS.md is created with a Rules section", () => {
	const dir = tmp();
	const file = join(dir, "AGENTS.md");
	appendRule(file, "Use pnpm for everything.");
	const body = readFileSync(file, "utf8");
	assert.match(body, /# AGENTS\.md/);
	assert.match(body, /## Rules/);
	assert.match(body, /- Use pnpm for everything\./);
});

test("an existing AGENTS.md gains the Rules section without losing content", () => {
	const dir = tmp();
	const file = join(dir, "AGENTS.md");
	writeFileSync(file, "# AGENTS.md\n\nBuild with npm. Be terse.\n");
	appendRule(file, "Run tests before committing.");
	const body = readFileSync(file, "utf8");
	assert.match(body, /Be terse\./);
	assert.match(body, /## Rules/);
	assert.match(body, /- Run tests before committing\./);
});

test("an existing Rules section gains the new rule at its end", () => {
	const dir = tmp();
	const file = join(dir, "AGENTS.md");
	writeFileSync(file, "# AGENTS.md\n\n## Rules\n\n- Old rule.\n");
	appendRule(file, "New rule.");
	const body = readFileSync(file, "utf8");
	const oldAt = body.indexOf("- Old rule.");
	const newAt = body.indexOf("- New rule.");
	assert.ok(oldAt >= 0 && newAt > oldAt);
});

test("an identical rule is not appended twice", () => {
	const dir = tmp();
	const file = join(dir, "AGENTS.md");
	appendRule(file, "Use bun.");
	appendRule(file, "Use bun.");
	assert.equal(readRules(file).length, 1);
});

test("rules differing only in surrounding whitespace count as identical", () => {
	const dir = tmp();
	const file = join(dir, "AGENTS.md");
	appendRule(file, "Use bun.");
	appendRule(file, "  Use bun.  ");
	assert.equal(readRules(file).length, 1);
});

test("readRules returns the rules in order for an existing file", () => {
	const dir = tmp();
	const file = join(dir, "AGENTS.md");
	writeFileSync(file, "# AGENTS.md\n\n## Rules\n\n- First.\n- Second.\n");
	assert.deepEqual(readRules(file), ["First.", "Second."]);
});

test("readRules on a missing file returns an empty list", () => {
	assert.deepEqual(readRules(join(tmp(), "nope.md")), []);
});
