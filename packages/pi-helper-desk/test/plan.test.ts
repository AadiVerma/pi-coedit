import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanState, allDone, doneCount, mergePlan, readSteps, snapshot } from "../src/plan.ts";
import type { PlanDetails } from "../src/types.ts";

test("readSteps accepts a clean list and rejects bad ones", () => {
	const ok = readSteps([
		{ text: "Read the brief", status: "completed" },
		{ text: "Draft the outline", status: "in_progress" },
	]);
	assert.ok("steps" in ok && ok.steps.length === 2);

	assert.ok("error" in readSteps("nope"));
	assert.ok("error" in readSteps([{ text: "  ", status: "pending" }]));
	assert.ok("error" in readSteps([{ text: "x", status: "done" }]));
	// Whitespace is collapsed, not rejected.
	const tidy = readSteps([{ text: "  Pull   the numbers ", status: "pending" }]);
	assert.ok("steps" in tidy && tidy.steps[0]?.text === "Pull the numbers");
});

test("mergePlan keeps done times by matching text, and reports what just finished", () => {
	const prev: PlanDetails = {
		title: "Make the deck",
		steps: [
			{ text: "Read the brief", status: "completed", doneAt: "2026-01-01T00:00:00.000Z" },
			{ text: "Draft the outline", status: "in_progress" },
			{ text: "Build the slides", status: "pending" },
		],
	};
	const merged = mergePlan(prev, false, undefined, [
		{ text: "Read the brief", status: "completed" },
		{ text: "Draft the outline", status: "completed" },
		{ text: "Build the slides", status: "in_progress" },
		{ text: "Check the deck", status: "pending" },
	]);
	assert.equal(merged.plan.title, "Make the deck");
	assert.equal(merged.plan.steps[0]?.doneAt, "2026-01-01T00:00:00.000Z");
	assert.notEqual(merged.plan.steps[1]?.doneAt, undefined);
	assert.deepEqual(merged.justDone, ["Draft the outline"]);
	assert.equal(merged.fresh, false);
});

test("mergePlan starts a new plan when work resumes after a finished one, with no just-done toasts", () => {
	const finished: PlanDetails = {
		title: "Old job",
		steps: [{ text: "Only step", status: "completed", doneAt: "2026-01-01T00:00:00.000Z" }],
	};
	const next = mergePlan(finished, true, "New job", [
		{ text: "Only step", status: "completed" },
		{ text: "Fresh step", status: "in_progress" },
	]);
	assert.equal(next.fresh, true);
	assert.equal(next.plan.title, "New job");
	assert.deepEqual(next.justDone, []);
});

test("mergePlan reuses the old title when none is sent mid-plan", () => {
	const prev: PlanDetails = { title: "Named job", steps: [{ text: "a", status: "in_progress" }] };
	const merged = mergePlan(prev, false, undefined, [{ text: "a", status: "completed" }]);
	assert.equal(merged.plan.title, "Named job");
});

test("PlanState.apply tracks visibility and the wasDone edge", () => {
	const state = new PlanState();
	assert.equal(state.visible, false);
	assert.equal(state.hasLivePlan(), false);

	state.apply("Smoke", [
		{ text: "one", status: "completed" },
		{ text: "two", status: "in_progress" },
	]);
	assert.equal(state.visible, true);
	assert.equal(state.hasLivePlan(), true);
	assert.equal(doneCount(state.plan!.steps), 1);

	state.apply(undefined, [
		{ text: "one", status: "completed" },
		{ text: "two", status: "completed" },
	]);
	assert.equal(state.wasDone, true);
	assert.equal(state.hasLivePlan(), false);
	assert.equal(state.visible, true); // still shown, holds for the done window

	// Work left in a list after a finished plan is a new plan.
	const applied = state.apply(undefined, [{ text: "next thing", status: "in_progress" }]);
	assert.equal(applied.fresh, true);
	assert.equal(state.plan!.title, "Plan");

	state.reset();
	assert.equal(state.plan, null);
});

test("PlanState.adopt rebuilds from stored details; a finished plan does not redraw", () => {
	const state = new PlanState();
	state.adopt({ title: "From the branch", steps: [{ text: "a", status: "in_progress" }] });
	assert.equal(state.plan?.title, "From the branch");
	assert.equal(state.visible, true);

	const cold = new PlanState();
	cold.adopt({ title: "Done job", steps: [{ text: "a", status: "completed" }] });
	assert.equal(cold.visible, false);
	assert.equal(allDone(cold.plan!.steps), true);
});

test("snapshot is a deep copy safe for session storage", () => {
	const state = new PlanState();
	state.apply("T", [{ text: "a", status: "completed" }]);
	const copy = snapshot(state.plan!);
	copy.steps[0]!.status = "pending";
	assert.equal(state.plan!.steps[0]!.status, "completed");
});
