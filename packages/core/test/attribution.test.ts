import { test } from "node:test";
import assert from "node:assert/strict";
import { AttributionEngine } from "../src/attribution.ts";
import { classifyChange } from "../src/detect.ts";
import { hunk, makeEvent } from "./helpers.ts";

function origins(e: AttributionEngine, file: string): string[] {
	const attr = e.get(file);
	return attr ? attr.lines.map((l) => l.origin) : [];
}

test("agent edit then human edit of the same line -> both", () => {
	const e = new AttributionEngine();
	e.markBaseline("a.ts", 3, null);
	e.applyEvent(makeEvent({ file: "a.ts", author: "agent", hunks: [hunk(1, 1, 1, 1)] }));
	assert.deepEqual(origins(e, "a.ts"), ["unchanged", "agent", "unchanged"]);
	e.applyEvent(makeEvent({ file: "a.ts", author: "human", hunks: [hunk(1, 1, 1, 1)] }));
	assert.deepEqual(origins(e, "a.ts"), ["unchanged", "both", "unchanged"]);
});

test("human edit then agent edit of the same line -> both", () => {
	const e = new AttributionEngine();
	e.markBaseline("a.ts", 2, null);
	e.applyEvent(makeEvent({ file: "a.ts", author: "human", hunks: [hunk(0, 1, 0, 1)] }));
	e.applyEvent(makeEvent({ file: "a.ts", author: "agent", hunks: [hunk(0, 1, 0, 1)] }));
	assert.deepEqual(origins(e, "a.ts"), ["both", "unchanged"]);
});

test("unknown author taints a line (never guessed)", () => {
	const e = new AttributionEngine();
	e.markBaseline("a.ts", 2, null);
	e.applyEvent(makeEvent({ file: "a.ts", author: "agent", hunks: [hunk(0, 1, 0, 1)] }));
	e.applyEvent(makeEvent({ file: "a.ts", author: "unknown", source: "editor", hunks: [hunk(0, 1, 0, 1)] }));
	assert.deepEqual(origins(e, "a.ts"), ["unknown", "unchanged"]);
});

test("insertions shift line numbers for later events", () => {
	const e = new AttributionEngine();
	e.markBaseline("a.ts", 2, null); // [L0, L1]
	e.applyEvent(makeEvent({ file: "a.ts", author: "human", hunks: [hunk(1, 0, 1, 2)] })); // insert 2 after L0
	assert.deepEqual(origins(e, "a.ts"), ["unchanged", "human", "human", "unchanged"]);
	e.applyEvent(makeEvent({ file: "a.ts", author: "agent", hunks: [hunk(3, 1, 3, 1)] })); // edit old L1
	assert.deepEqual(origins(e, "a.ts"), ["unchanged", "human", "human", "agent"]);
});

test("deletions remove attributed lines", () => {
	const e = new AttributionEngine();
	e.markBaseline("a.ts", 4, null);
	e.applyEvent(makeEvent({ file: "a.ts", author: "agent", hunks: [hunk(1, 2, 1, 0)] }));
	assert.deepEqual(origins(e, "a.ts"), ["unchanged", "unchanged"]);
});

test("event on a never-observed existing file infers unknown lines", () => {
	const e = new AttributionEngine();
	e.applyEvent(makeEvent({ file: "legacy.ts", author: "agent", hunks: [hunk(2, 1, 2, 1)] }));
	assert.equal(origins(e, "legacy.ts").length, 3);
	assert.deepEqual(origins(e, "legacy.ts"), ["unknown", "unknown", "agent"]);
});

test("file created then deleted then recreated", () => {
	const e = new AttributionEngine();
	e.applyEvent(makeEvent({ file: "new.ts", author: "agent", source: "pi-write", beforeHash: null, hunks: [hunk(0, 0, 0, 2)] }));
	assert.deepEqual(origins(e, "new.ts"), ["agent", "agent"]);
	e.applyEvent(makeEvent({ file: "new.ts", author: "human", afterHash: null, hunks: [] }));
	assert.equal(e.get("new.ts"), undefined);
	e.applyEvent(makeEvent({ file: "new.ts", author: "human", source: "editor", beforeHash: null, hunks: [hunk(0, 0, 0, 3)] }));
	assert.deepEqual(origins(e, "new.ts"), ["human", "human", "human"]);
});

test("binary files are tracked without lines", () => {
	const e = new AttributionEngine();
	e.applyEvent(makeEvent({ file: "img.png", author: "agent", binary: true, hunks: [] }));
	assert.equal(e.get("img.png")?.binary, true);
	assert.equal(e.get("img.png")?.lines.length, 0);
});

test("rename carries attribution to the new path", () => {
	const e = new AttributionEngine();
	e.markBaseline("old.ts", 2, null);
	e.applyEvent(makeEvent({ file: "old.ts", author: "human", hunks: [hunk(0, 1, 0, 1)] }));
	e.handleRename("old.ts", "new.ts");
	assert.equal(e.get("old.ts"), undefined);
	assert.deepEqual(origins(e, "new.ts"), ["human", "unchanged"]);
});

test("resetBaseline marks lines matching new HEAD unchanged, keeps dirty origins", () => {
	const e = new AttributionEngine();
	e.markBaseline("a.ts", 4, null);
	e.applyEvent(makeEvent({ file: "a.ts", author: "agent", hunks: [hunk(0, 1, 0, 1)] })); // line 0 dirty
	e.applyEvent(makeEvent({ file: "a.ts", author: "human", hunks: [hunk(3, 0, 3, 1)] })); // new dirty line 3
	// Commit happens; new HEAD still differs from worktree at inserted line 3.
	e.resetBaseline("a.ts", [{ delStart: 3, delCount: 0, insStart: 3, insCount: 1 }]);
	assert.deepEqual(origins(e, "a.ts"), ["unchanged", "unchanged", "unchanged", "human", "unchanged"]);
});

test("summary counts by origin", () => {
	const e = new AttributionEngine();
	e.markBaseline("a.ts", 3, null);
	e.applyEvent(makeEvent({ file: "a.ts", author: "agent", hunks: [hunk(0, 1, 0, 1)] }));
	e.applyEvent(makeEvent({ file: "a.ts", author: "human", hunks: [hunk(0, 1, 0, 1)] }));
	const s = e.summary().find((x) => x.file === "a.ts");
	assert.deepEqual(s, { file: "a.ts", human: 0, agent: 0, both: 1, unknown: 0 });
});

test("classifyChange implements the documented detection rules", () => {
	assert.equal(classifyChange({ editorSeenHuman: false, inAgentWindow: false }), "human");
	assert.equal(classifyChange({ editorSeenHuman: false, inAgentWindow: true }), "agent");
	assert.equal(classifyChange({ editorSeenHuman: true, inAgentWindow: false }), "human");
	assert.equal(classifyChange({ editorSeenHuman: true, inAgentWindow: true }), "unknown");
});

test("replay rebuilds state from the event log", () => {
	const events = [
		makeEvent({ file: "a.ts", author: "agent", beforeHash: null, hunks: [hunk(0, 0, 0, 2)] }),
		makeEvent({ file: "a.ts", author: "human", hunks: [hunk(1, 1, 1, 1)] }),
	];
	const a = new AttributionEngine();
	for (const ev of events) a.applyEvent(ev);
	const b = new AttributionEngine();
	b.replay(events);
	assert.deepEqual(b.get("a.ts"), a.get("a.ts"));
});
