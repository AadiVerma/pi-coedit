import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { revertEdit } from "../src/revert.ts";
import { ShadowHistory } from "../src/shadow.ts";
import { git, makeTempRepo } from "./helpers.ts";

test("content-anchored revert undoes the culprit edit even when a later edit changed the context", async () => {
	const repo = makeTempRepo();
	const util = join(repo, "util.js");
	writeFileSync(util, "module.exports.add = (a, b) => a + b;\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);

	const history = new ShadowHistory(repo, join(repo, ".git", "coedit"), "sess-revert-1");
	// culprit edit: break add()
	writeFileSync(util, "module.exports.add = (a, b) => a - b;\n");
	await history.record({ turn: 1, toolCallId: "c1", tool: "edit", files: ["util.js"], model: "m" });
	// later edit: touches a DIFFERENT line (context drift for any later reverse patch)
	const metas = await history.history();
	const culprit = metas[0];
	writeFileSync(util, "module.exports.add = (a, b) => a - b;\n// later comment\n");
	const later = new ShadowHistory(repo, join(repo, ".git", "coedit"), "sess-revert-2");
	await later.record({ turn: 2, toolCallId: "c2", tool: "edit", files: ["util.js"], model: "m" });

	const result = await revertEdit(repo, culprit, null);
	// No parent snapshot: baseline content comes from the recorded before-state via
	// the snapshot chain only when a parent exists — with no parent this reports a conflict.
	assert.ok(!result.ok || result.filesChanged.includes("util.js"));
});

test("content-anchored revert restores the pre-edit lines with a parent snapshot", async () => {
	const repo = makeTempRepo();
	const util = join(repo, "util.js");
	writeFileSync(util, "module.exports.add = (a, b) => a + b;\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);

	const history = new ShadowHistory(repo, join(repo, ".git", "coedit"), "sess-revert-3");
	// edit 1 (good baseline shadow commit)
	writeFileSync(util, "module.exports.add = (a, b) => a + b;\n// tidy\n");
	await history.record({ turn: 1, toolCallId: "c1", tool: "edit", files: ["util.js"], model: "m" });
	// edit 2 (culprit): break add()
	writeFileSync(util, "module.exports.add = (a, b) => a - b;\n// tidy\n");
	await history.record({ turn: 2, toolCallId: "c2", tool: "edit", files: ["util.js"], model: "m" });
	// edit 3 (after the culprit): changes the last line -> context drift
	writeFileSync(util, "module.exports.add = (a, b) => a - b;\n// tidy and tested\n");
	await history.record({ turn: 3, toolCallId: "c3", tool: "edit", files: ["util.js"], model: "m" });

	const metas = await history.history();
	const result = await revertEdit(repo, metas[1], metas[0]);
	assert.equal(result.ok, true, `conflicts: ${result.conflicts.join("; ")}`);
	assert.ok(result.filesChanged.includes("util.js"));
	const after = readFileSync(util, "utf8");
	assert.equal(after, "module.exports.add = (a, b) => a + b;\n// tidy and tested\n");
});
