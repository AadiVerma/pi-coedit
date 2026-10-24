import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "@coedit/core";
import { createHarness, git, makeRepo, realRepo, wf } from "./harness.ts";

test("SCEN: committing clears the footer and returns committed lines to unchanged", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "l1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo, { mode: "tui" });
	await h.startSession();

	// agent edits a.js via the real tool path
	await h.dispatch("tool_execution_start", { toolName: "edit", toolCallId: "e1", args: { path: "a.js", edits: [] } });
	wf(repo, "a.js", "l1\nl2-agent\n");
	await h.dispatch("tool_execution_end", { toolName: "edit", toolCallId: "e1", isError: false });

	const store = await Store.open(repo, join(repo, ".git"));
	const before = store.events({ worktree: realRepo(repo) }).length;
	assert.ok(before > 0, "agent edit recorded");

	// footer shows the agent's file
	assert.ok((h.widget.content?.[0] ?? "").includes("agent"), `pre-commit footer: ${h.widget.content?.[0]}`);

	// user commits everything
	writeFileSync(join(repo, "b.js"), "b\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "feat: agent edit + b.js"]);

	// next turn boundary detects the new HEAD
	await h.dispatch("turn_start");

	// attribution handed over: committed lines are unchanged → footer gone
	assert.equal(h.widget.content, undefined, `post-commit footer should be hidden, got: ${h.widget.content?.[0]}`);

	// Git AI–standard note attached for the commit (git-ai absent in this env)
	const note = git(repo, ["notes", "--ref=ai", "show", "HEAD"]);
	assert.match(note, /a\.js/);
	assert.match(note, /schema_version/);
	assert.match(note, /s_[0-9a-f]{14}::t_[0-9a-f]{14}/);

	// still-dirty work keeps origins: agent edits again WITHOUT committing
	await h.dispatch("tool_execution_start", { toolName: "edit", toolCallId: "e2", args: { path: "a.js", edits: [] } });
	wf(repo, "a.js", "l1\nl2-agent\nl3-new\n");
	await h.dispatch("tool_execution_end", { toolName: "edit", toolCallId: "e2", isError: false });
	assert.ok((h.widget.content?.[0] ?? "").includes("agent"), "footer returns for new uncommitted work");

	store.close();
	await h.shutdownSession();
});


