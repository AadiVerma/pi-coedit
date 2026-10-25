import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanState, allDone, doneCount, isStatus, mergePlan, readSteps, snapshot } from "../src/plan.ts";
import type { PlanDetails } from "../src/types.ts";

// ---- readSteps: the whole zoo of bad and odd input ----

test("readSteps refuses non-array input of every shape", () => {
	for (const bad of ["steps", 42, true, null, undefined, { text: "a", status: "pending" }]) {
		const r = readSteps(bad);
		assert.ok("error" in r, `${JSON.stringify(bad)} is refused`);
	}
});

test("readSteps treats a non-object item as an empty step and refuses it for missing text", () => {
	for (const item of [null, undefined, 42, "text", [], true]) {
		const r = readSteps([item]);
		assert.ok("error" in r, `${JSON.stringify(item)} is refused`);
	}
});

test("readSteps refuses a missing status and a missing text separately", () => {
	assert.match((readSteps([{ status: "pending" }]) as { error: string }).error, /needs its text/);
	assert.match((readSteps([{ text: "a" }]) as { error: string }).error, /needs a status/);
});

test("readSteps is case sensitive: Complete is not completed", () => {
	const r = readSteps([{ text: "a", status: "Complete" }]);
	assert.ok("error" in r);
});

test("readSteps keeps long and unicode text as it is", () => {
	const long = "字".repeat(200);
	const r = readSteps([{ text: long, status: "pending" }]);
	assert.ok("steps" in r);
	assert.equal(r.steps[0].text, long);
});

test("readSteps allows an empty list: a plan with no steps", () => {
	const r = readSteps([]);
	assert.deepEqual(r, { steps: [] });
});

test("readSteps ignores extra fields on a step", () => {
	const r = readSteps([{ text: "a", status: "pending", junk: 1, id: "x" }]);
	assert.ok("steps" in r);
	assert.deepEqual(r.steps[0], { text: "a", status: "pending" });
});

test("isStatus accepts exactly the three statuses", () => {
	assert.equal(isStatus("pending"), true);
	assert.equal(isStatus("in_progress"), true);
	assert.equal(isStatus("completed"), true);
	for (const bad of ["Pending", "in progress", "inprogress", "done", "", "pending ", null, undefined, 0]) {
		assert.equal(isStatus(bad), false, `${String(bad)} is not a status`);
	}
});

// ---- mergePlan: matching, titles, and the done edge ----

test("mergePlan matches by text, not by position", () => {
	const prev: PlanDetails = {
		title: "T",
		steps: [
			{ text: "first", status: "completed", doneAt: "2026-01-01T00:00:00.000Z" },
			{ text: "second", status: "pending" },
		],
	};
	const merged = mergePlan(prev, false, undefined, [
		{ text: "second", status: "pending" },
		{ text: "first", status: "completed" },
	]);
	// first keeps its old done time even though it moved to the end.
	assert.equal(merged.plan.steps[1].doneAt, "2026-01-01T00:00:00.000Z");
});

test("mergePlan consumes each old step once when the incoming list repeats a text", () => {
	const prev: PlanDetails = {
		title: "T",
		steps: [{ text: "dup", status: "completed", doneAt: "2026-01-01T00:00:00.000Z" }],
	};
	const merged = mergePlan(prev, false, undefined, [
		{ text: "dup", status: "completed" },
		{ text: "dup", status: "completed" },
	]);
	// The first repeat matches the old step and keeps its stamp; the second has nothing
	// left to match, so it is a brand-new step that just completed.
	assert.equal(merged.plan.steps[0].doneAt, "2026-01-01T00:00:00.000Z", "the first keeps its stamp");
	assert.notEqual(merged.plan.steps[1].doneAt, "2026-01-01T00:00:00.000Z", "the second is stamped fresh");
	assert.deepEqual(merged.justDone, ["dup"], "only the unmatched repeat reports a completion");
});

test("mergePlan stamps a newly completed step that was never seen", () => {
	const merged = mergePlan(null, false, "T", [{ text: "new", status: "completed" }]);
	assert.ok((merged.plan.steps[0].doneAt ?? "").length > 0);
});

test("mergePlan does not report a completion for a fresh plan, even over an old done plan", () => {
	const prev: PlanDetails = { title: "Old", steps: [{ text: "a", status: "completed" }] };
	const merged = mergePlan(prev, true, "New", [{ text: "a", status: "completed" }]);
	assert.deepEqual(merged.justDone, []);
});

test("mergePlan trims the title and falls back by state", () => {
	const prev: PlanDetails = { title: "Kept", steps: [{ text: "a", status: "pending" }] };
	assert.equal(mergePlan(null, false, "  Trimmed  ", []).plan.title, "Trimmed");
	assert.equal(mergePlan(null, false, undefined, []).plan.title, "Plan");
	assert.equal(mergePlan(prev, false, undefined, [{ text: "a", status: "completed" }]).plan.title, "Kept");
	assert.equal(mergePlan(prev, false, "   ", [{ text: "a", status: "completed" }]).plan.title, "Kept");
	assert.equal(mergePlan(prev, true, undefined, [{ text: "b", status: "in_progress" }]).plan.title, "Plan");
});

test("mergePlan keeps wasDone only when the plan really stays done", () => {
	const done: PlanDetails = { title: "D", steps: [{ text: "a", status: "completed" }] };
	assert.equal(mergePlan(done, true, undefined, [{ text: "a", status: "completed" }]).wasDone, true);
	assert.equal(mergePlan(done, true, undefined, [{ text: "a", status: "in_progress" }]).wasDone, false);
	const live: PlanDetails = { title: "L", steps: [{ text: "a", status: "in_progress" }] };
	assert.equal(mergePlan(live, false, undefined, [{ text: "a", status: "completed" }]).wasDone, false);
});

test("mergePlan reports several just-done steps in incoming order", () => {
	const prev: PlanDetails = {
		title: "T",
		steps: [
			{ text: "a", status: "in_progress" },
			{ text: "b", status: "in_progress" },
			{ text: "c", status: "pending" },
		],
	};
	const merged = mergePlan(prev, false, undefined, [
		{ text: "c", status: "completed" },
		{ text: "a", status: "completed" },
		{ text: "b", status: "completed" },
	]);
	assert.deepEqual(merged.justDone, ["c", "a", "b"]);
});

// ---- allDone / doneCount ----

test("allDone is false for an empty list and for any unfinished step", () => {
	assert.equal(allDone([]), false);
	assert.equal(allDone([{ text: "a", status: "completed" }]), true);
	assert.equal(allDone([{ text: "a", status: "pending" }]), false);
	assert.equal(allDone([{ text: "a", status: "completed" }, { text: "b", status: "pending" }]), false);
});

test("doneCount counts only completed steps", () => {
	assert.equal(doneCount([{ status: "completed" }, { status: "in_progress" }, { status: "completed" }]), 2);
	assert.equal(doneCount([]), 0);
});

// ---- snapshot ----

test("snapshot copies every field and omits doneAt when absent", () => {
	const plan: PlanDetails = {
		title: "T",
		steps: [{ text: "a", status: "completed", doneAt: "2026-01-01T00:00:00.000Z" }, { text: "b", status: "pending" }],
	};
	const copy = snapshot(plan);
	assert.deepEqual(copy, plan);
	assert.equal("doneAt" in copy.steps[1], false);
});

test("snapshot survives an empty plan", () => {
	assert.deepEqual(snapshot({ title: "", steps: [] }), { title: "", steps: [] });
});

// ---- PlanState ----

test("apply with an empty list hides the bar", () => {
	const state = new PlanState();
	state.apply("T", []);
	assert.equal(state.visible, false);
	assert.equal(state.plan?.steps.length, 0);
});

test("adopt refuses malformed details and keeps the state empty", () => {
	const state = new PlanState();
	state.adopt(undefined as unknown as PlanDetails);
	state.adopt({ title: "T" } as unknown as PlanDetails);
	state.adopt({ title: "T", steps: "nope" } as unknown as PlanDetails);
	assert.equal(state.plan, null);
	assert.equal(state.visible, false);
});

test("adopt keeps an empty title out: it reads Plan", () => {
	const state = new PlanState();
	state.adopt({ title: "", steps: [{ text: "a", status: "pending" }] });
	assert.equal(state.plan?.title, "Plan");
});

test("adopt then apply continues the adopted plan, not a fresh one", () => {
	const state = new PlanState();
	state.adopt({ title: "Carried", steps: [{ text: "a", status: "in_progress" }] });
	const applied = state.apply(undefined, [{ text: "a", status: "completed" }]);
	assert.equal(applied.fresh, false);
	assert.equal(state.plan?.title, "Carried");
	assert.deepEqual(applied.justDone, ["a"]);
});

test("adopt of a finished plan, then work: the next list is a fresh plan", () => {
	const state = new PlanState();
	state.adopt({ title: "Done before", steps: [{ text: "a", status: "completed" }] });
	state.apply(undefined, [{ text: "b", status: "in_progress" }]);
	assert.equal(state.plan?.title, "Plan", "a fresh plan without a title");
	assert.equal(state.visible, true);
});

test("hasLivePlan is false for an empty-step plan", () => {
	const state = new PlanState();
	state.apply("T", []);
	assert.equal(state.hasLivePlan(), false);
});

test("the state machine walks a full cycle: plan, finish, hold, new plan", () => {
	const state = new PlanState();
	state.apply("A", [{ text: "1", status: "in_progress" }, { text: "2", status: "pending" }]);
	assert.equal(state.visible, true);
	assert.equal(state.hasLivePlan(), true);

	state.apply(undefined, [{ text: "1", status: "completed" }, { text: "2", status: "in_progress" }]);
	assert.equal(state.wasDone, false);

	state.apply(undefined, [{ text: "1", status: "completed" }, { text: "2", status: "completed" }]);
	assert.equal(state.wasDone, true);
	assert.equal(state.visible, true, "held at 100%");

	// The hide timer flips shown; the state stays done until new work arrives.
	state.shown = false;
	assert.equal(state.visible, false);

	const next = state.apply(undefined, [{ text: "3", status: "in_progress" }]);
	assert.equal(next.fresh, true);
	assert.equal(state.visible, true);
	assert.equal(state.plan?.title, "Plan", "a fresh plan without a title reads Plan");
});

test("a fresh plan after a done one is titled Plan unless a title arrives", () => {
	const state = new PlanState();
	state.apply("A", [{ text: "1", status: "completed" }]);
	const noTitle = state.apply(undefined, [{ text: "2", status: "in_progress" }]);
	assert.equal(noTitle.fresh, true);
	assert.equal(state.plan?.title, "Plan");
	const titled = state.apply("B", [{ text: "2", status: "in_progress" }]);
	assert.equal(titled.fresh, false, "the plan is live now, not done");
	assert.equal(state.plan?.title, "B");
});
