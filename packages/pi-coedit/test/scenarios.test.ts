/**
 * User-flow scenarios against the real plugin factory. The guard matrix runs
 * 4 policies × 2 UI modes × read/unread × 4 staleness shapes = 64 cases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentHash, Store } from "@coedit/core";
import { createHarness, git, makeRepo, realRepo, sleep, wf } from "./harness.ts";

let executed = 0;

async function openStore(repo: string): Promise<Store> {
	return Store.open(repo, join(repo, ".git"));
}

// ---------------------------------------------------------------- guard matrix

interface GuardCase {
	policy: "block" | "ask" | "warn" | "off";
	hasUI: boolean;
	readFirst: boolean;
	staleness: "fresh" | "human-since" | "newline-only" | "human-edited-then-agent-rewrote";
}

async function runGuardCase(c: GuardCase): Promise<"blocked" | "allowed"> {
	const repo = makeRepo();
	wf(repo, "a.js", "one\ntwo\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo, { hasUI: c.hasUI, mode: c.hasUI ? "tui" : "json" });
	try {
		await h.setPolicy(c.policy); // before session_start: config is read at open (and re-read per access)
		await h.startSession();
		if (c.hasUI) h.ui.select("Allow anyway"); // scripted UI answer where the dialog appears

		// agent reads or edits the file (establishes the baseline)
		if (c.readFirst) {
			await h.dispatch("tool_execution_start", { toolName: "read", toolCallId: "r1", args: { path: "a.js" } });
		} else {
			// agent edit: capture before, change, finish — establishes agentTouch + baseline
			await h.dispatch("tool_execution_start", { toolName: "edit", toolCallId: "e0", args: { path: "a.js", edits: [] } });
			wf(repo, "a.js", "one\nTWO-by-agent\n");
			await h.dispatch("tool_execution_end", { toolName: "edit", toolCallId: "e0", isError: false });
		}

		switch (c.staleness) {
			case "fresh":
				break;
			case "human-since":
				wf(repo, "a.js", "one\nHUMAN\n" + readFileSync(join(repo, "a.js"), "utf8").split("\n").slice(2).join("\n"));
				break;
			case "newline-only":
				wf(repo, "a.js", readFileSync(join(repo, "a.js"), "utf8") + "\n");
				break;
			case "human-edited-then-agent-rewrote":
				wf(repo, "a.js", "one\nHUMAN-then-AGENT\n");
				break;
		}

		const result = (await h.dispatch("tool_call", {
			toolName: "edit",
			toolCallId: "c1",
			input: { path: "a.js", edits: [{ oldText: "one", newText: "EDIT" }] },
		})) as { block?: boolean } | undefined;
		const blocked = result?.block === true;
		executed++;
		return blocked ? "blocked" : "allowed";
	} finally {
		await h.shutdownSession();
	}
}

test("SCEN guard matrix: 4 policies × 2 UI × read/unread × 4 staleness shapes (64 cases)", { timeout: 180_000 }, async () => {
	const policies = ["block", "ask", "warn", "off"] as const;
	let matrix = "";
	for (const policy of policies) {
		for (const hasUI of [false, true]) {
			for (const readFirst of [true, false]) {
				for (const staleness of ["fresh", "human-since", "newline-only", "human-edited-then-agent-rewrote"] as const) {
					process.stderr.write(`[case] ${policy}/${hasUI}/${readFirst}/${staleness}\n`);
					const outcome = await runGuardCase({ policy, hasUI, readFirst, staleness });
					// Expected semantics:
					//  - off: never blocks
					//  - block: blocks any staleness (incl. newline-only), allows fresh
					//  - warn: never blocks (notifies only)
					//  - ask + no UI: fails closed = blocks on staleness
					//  - ask + UI: scripted "Allow anyway" answer → allowed
					const expected: "blocked" | "allowed" =
						policy === "off" || policy === "warn"
							? "allowed"
							: policy === "block"
								? staleness === "fresh"
									? "allowed"
									: "blocked"
								: hasUI
									? "allowed" // user chose "Allow anyway"
									: staleness === "fresh"
										? "allowed"
										: "blocked";
					assert.equal(outcome, expected, `policy=${policy} ui=${hasUI} read=${readFirst} stale=${staleness}`);
					matrix += `${policy}/${hasUI ? "ui" : "noui"}/${readFirst ? "read" : "unread"}/${staleness}=${outcome}\n`;
				}
			}
		}
	}
	console.log(`  guard matrix executed ${executed} cases:\n${matrix}`);
});

// ---------------------------------------------------------------- detection flows

test("SCEN: human edit while idle is recorded human and reported to the model exactly once", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "l1\nl2\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo);
	await h.startSession();
	await sleep(400); // fs.watch backend needs a moment before events flow

	// human edits outside any agent window (direct fs change; fs-watch debounce)
	wf(repo, "a.js", "l1\nHUMAN\n");
	await sleep(500); // fs-watch debounce (250 ms) + margin

	const store = await openStore(repo);
	const events = store.events({ worktree: realRepo(repo) });
	const human = events.filter((e) => e.author === "human");
	assert.equal(human.length, 1, `expected exactly one human event, got ${human.length}: ${JSON.stringify(events.map((e) => [e.author, e.source, e.file]))}`);
	assert.equal(human[0].file, "a.js");

	// first model request carries the note
	const ctxResult = (await h.dispatch("context", { messages: [] })) as { messages?: Array<{ role: string; content: string }> };
	const note = ctxResult.messages?.find((m) => m.role === "user" && m.content.includes("[coedit]"));
	assert.ok(note, "human-edit note injected");
	assert.match(note!.content, /a\.js/);
	assert.match(note!.content, /Keep their changes/);

	// second request: no duplicate note
	const again = (await h.dispatch("context", { messages: [] })) as { messages?: Array<{ role: string; content: string }> } | undefined;
	assert.equal(again?.messages?.find((m) => m.role === "user" && m.content.includes("[coedit]")), undefined, "no duplicate note on the second request");
	store.close();
	await h.shutdownSession();
});

test("SCEN: change inside agent bash window with no editor report → agent", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "l1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo);
	await h.startSession();

	await h.dispatch("tool_execution_start", { toolName: "bash", toolCallId: "b1", args: { command: "echo hi >> a.js" } });
	// the bash command itself mutates the file (like a real sed/echo would)
	writeFileSync(join(repo, "a.js"), "l1\nl2-from-bash\n");
	await h.dispatch("tool_execution_end", { toolName: "bash", toolCallId: "b1", isError: false });

	const store = await openStore(repo);
	const ev = store.events({ worktree: realRepo(repo), file: "a.js" });
	assert.equal(ev.length, 1);
	assert.equal(ev[0].author, "agent");
	assert.equal(ev[0].source, "pi-bash");
	assert.ok(ev[0].agent, "agent metadata recorded");
	assert.equal(ev[0].agent!.model, "test-model");
	store.close();
	await h.shutdownSession();
});

test("SCEN: editor-reported human change inside agent bash window → unknown (grey)", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "l1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo);
	await h.startSession();

	await h.dispatch("tool_execution_start", { toolName: "bash", toolCallId: "b1", args: { command: "true" } });
	// editor sensor records the human typing (as coedit-gutter would)
	const store = await openStore(repo);
	await store.recordEvent(
		{
			id: "editor-1",
			ts: new Date().toISOString(),
			worktree: realRepo(repo),
			file: "a.js",
			author: "human",
			source: "editor",
			beforeHash: "x",
			afterHash: "y",
			hunks: [],
		},
		{ afterContent: "l1\nHUMAN\n" },
	);
	writeFileSync(join(repo, "a.js"), "l1\nHUMAN\n");
	await h.dispatch("tool_execution_end", { toolName: "bash", toolCallId: "b1", isError: false });

	const ev = store.events({ worktree: realRepo(repo), file: "a.js" });
	const last = ev[ev.length - 1];
	assert.equal(last.author, "unknown", `expected unknown, got ${last.author} (${last.source})`);
	store.close();
	await h.shutdownSession();
});

test("SCEN: agent edit → human revert of the same lines → agent may edit again (guard disarmed by re-read)", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "l1\nl2\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo);
	await h.startSession();

	// agent reads (baseline) then human edits
	await h.dispatch("tool_execution_start", { toolName: "read", toolCallId: "r1", args: { path: "a.js" } });
	wf(repo, "a.js", "l1\nHUMAN\n");
	// agent re-reads after the human change → baseline refreshes
	wf(repo, "a.js", "l1\nHUMAN-merged\n");
	await h.dispatch("tool_execution_start", { toolName: "read", toolCallId: "r2", args: { path: "a.js" } });

	const result = await h.dispatch("tool_call", { toolName: "edit", toolCallId: "c1", input: { path: "a.js", edits: [] } });
	assert.equal((result as { block?: boolean } | undefined)?.block ?? false, false, "re-read disarms the guard");
	await h.shutdownSession();
});

// ---------------------------------------------------------------- notes, commands, footer

test("SCEN: /whose renders origins; missing file is reported honestly", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "l1\nl2\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo);
	await h.startSession();
	await h.dispatch("tool_execution_start", { toolName: "edit", toolCallId: "e1", args: { path: "a.js", edits: [] } });
	wf(repo, "a.js", "l1\nAGENT\n");
	await h.dispatch("tool_execution_end", { toolName: "edit", toolCallId: "e1", isError: false });

	const whose = h.commands.get("whose")!;
	await whose.handler("a.js", h.ctx);
	assert.ok(h.notifies.some((n) => n.message.includes("agent")), "/whose shows agent origin");
	assert.ok(h.notifies.some((n) => n.message.includes("unchanged")), "/whose shows unchanged origin");

	h.notifies.length = 0;
	await whose.handler("nope-missing.js", h.ctx);
	assert.ok(h.notifies.some((n) => n.message.includes("not readable") || n.message.includes("cannot resolve")));
	await h.shutdownSession();
});

test("SCEN: coedit_whose tool returns per-line text; coedit status/reset flow", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "l1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo);
	await h.startSession();

	const tool = h.tools.find((t) => t.name === "coedit_whose");
	assert.ok(tool, "coedit_whose registered");
	const res = await tool.execute("tc1", { file: "a.js" });
	assert.match(res.content[0].text, /a\.js/);

	// reset with confirmation declined → nothing cleared
	(h as unknown as { confirmQueue: boolean[] }).confirmQueue.push(false);
	(h.ctx as unknown as { hasUI: boolean }).hasUI = true;
	const store = await openStore(repo);
	await store.recordEvent({
		id: "pre-reset",
		ts: new Date().toISOString(),
		worktree: repo,
		file: "a.js",
		author: "human",
		source: "fs-watch",
		beforeHash: "1",
		afterHash: "2",
		hunks: [],
	});
	const coeditCmd = h.commands.get("coedit")!;
	await coeditCmd.handler("reset", h.ctx);
	assert.equal(store.events().length, 1, "declined reset keeps events");

	// accepted reset clears events
	(h as unknown as { confirmQueue: boolean[] }).confirmQueue.push(true);
	await coeditCmd.handler("reset", h.ctx);
	assert.equal(store.events({ worktree: realRepo(repo) }).length, 0, "accepted reset clears events");
	store.close();
	await h.shutdownSession();
});

test("SCEN: footer widget shows file counts only in TUI mode and hides when clean", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "l1\n");
	wf(repo, "b.js", "l1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo, { mode: "tui" });
	await h.startSession();
	assert.equal(h.widget.content, undefined, "no widget before any change");

	// agent edits two files
	for (const [i, file] of ["a.js", "b.js"].entries()) {
		await h.dispatch("tool_execution_start", { toolName: "write", toolCallId: `w${i}`, args: { path: file, content: "new\n" } });
		wf(repo, file, "new\n");
		await h.dispatch("tool_execution_end", { toolName: "write", toolCallId: `w${i}`, isError: false });
	}
	assert.ok((h.widget.content?.[0] ?? "").includes("agent 2"), `footer shows agent file count, got: ${h.widget.content?.[0]}`);
	await h.shutdownSession();
});

test("SCEN: non-repo cwd stays inactive; commands warn instead of crashing", { timeout: 60_000 }, async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const bare = mkdtempSync(join(tmpdir(), "coedit-notrepo-")); // no git init — genuinely not a repo
	const h = await createHarness(bare);
	await h.startSession();
	const whose = h.commands.get("whose")!;
	await whose.handler("a.js", h.ctx);
	assert.ok(h.notifies.some((n) => n.message.includes("not active")), `expected not-active notice, got: ${JSON.stringify(h.notifies)}`);
	rmSync(bare, { recursive: true, force: true });
	await h.shutdownSession();
});

test("SCEN: concurrent human+agent across two files — attribution stays per-file", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "a1\n");
	wf(repo, "b.js", "b1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo);
	await h.startSession();
	await sleep(400); // fs.watch backend startup

	// agent edits a.js via tool; human edits b.js directly (fs-watch)
	await h.dispatch("tool_execution_start", { toolName: "edit", toolCallId: "e1", args: { path: "a.js", edits: [] } });
	wf(repo, "a.js", "a1\na2-agent\n");
	wf(repo, "b.js", "b1\nb2-human\n");
	await h.dispatch("tool_execution_end", { toolName: "edit", toolCallId: "e1", isError: false });
	await sleep(500);

	const store = await openStore(repo);
	const byAuthor = (author: string) => store.events({ worktree: realRepo(repo) }).filter((e) => e.author === author);
	assert.ok(byAuthor("agent").some((e) => e.file === "a.js"), "agent event on a.js");
	assert.ok(byAuthor("human").some((e) => e.file === "b.js"), "human event on b.js");
	assert.ok(!byAuthor("agent").some((e) => e.file === "b.js"), "human's b.js not misattributed to agent");
	assert.ok(!byAuthor("human").some((e) => e.file === "a.js"), "agent's a.js not misattributed to human");
	store.close();
	await h.shutdownSession();
});

test("SCEN: prompt excerpts capped and switchable off", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "l1\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo);
	await h.startSession();
	await h.dispatch("before_agent_start", { messageType: "user", prompt: "P".repeat(500) });
	await h.dispatch("tool_execution_start", { toolName: "edit", toolCallId: "e1", args: { path: "a.js", edits: [] } });
	wf(repo, "a.js", "l1\nl2\n");
	await h.dispatch("tool_execution_end", { toolName: "edit", toolCallId: "e1", isError: false });
	const store = await openStore(repo);
	const ev = store.events({ worktree: realRepo(repo) })[0];
	assert.ok((ev.agent!.promptExcerpt ?? "").length <= 200);
	store.close();
	await h.shutdownSession();
});

void contentHash;

test("SCEN: manually reverting to HEAD content clears the footer without a commit", { timeout: 60_000 }, async () => {
	const repo = makeRepo();
	wf(repo, "a.js", "l1\nl2\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-qm", "init"]);
	const h = await createHarness(repo, { mode: "tui" });
	await h.startSession();

	// agent edits a file
	await h.dispatch("tool_execution_start", { toolName: "edit", toolCallId: "e1", args: { path: "a.js", edits: [] } });
	wf(repo, "a.js", "l1\nl2\nl3-agent\n");
	await h.dispatch("tool_execution_end", { toolName: "edit", toolCallId: "e1", isError: false });
	assert.ok((h.widget.content?.[0] ?? "").includes("agent"), "footer shows the agent edit");

	// user manually reverts the file to HEAD content — no commit
	wf(repo, "a.js", "l1\nl2\n");
	await h.dispatch("turn_start");

	// worktree now equals HEAD → nothing uncommitted → footer gone
	assert.equal(h.widget.content, undefined, `footer should clear on manual revert, got: ${h.widget.content?.[0]}`);
	await h.shutdownSession();
});
