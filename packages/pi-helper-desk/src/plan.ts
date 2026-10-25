import type { PlanDetails, PlanStatus, PlanStep } from "./types.ts";

const STATUSES: readonly PlanStatus[] = ["pending", "in_progress", "completed"];

export const isStatus = (v: unknown): v is PlanStatus =>
	typeof v === "string" && (STATUSES as readonly string[]).includes(v);

export const doneCount = (steps: { status: PlanStatus }[]) => steps.filter((s) => s.status === "completed").length;

export const allDone = (steps: PlanStep[]) => steps.length > 0 && steps.every((s) => s.status === "completed");

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

export type StepIn = { text: string; status: PlanStatus };

/**
 * Validates the steps a model sent. Returns the cleaned list, or an error message.
 * Every step needs its text; every status one of the three.
 */
export function readSteps(raw: unknown): { steps: StepIn[] } | { error: string } {
	if (!Array.isArray(raw)) return { error: "send steps as a list of { text, status }" };
	const steps: StepIn[] = [];
	for (const item of raw) {
		const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
		const text = typeof o.text === "string" ? oneLine(o.text) : "";
		if (!text) return { error: "every step needs its text" };
		if (!isStatus(o.status)) return { error: `"${text.slice(0, 40)}" needs a status of pending, in_progress or completed` };
		steps.push({ text, status: o.status });
	}
	return { steps };
}

/**
 * Takes a whole new list, keeps done times of steps that match by text, and reports
 * what just finished. A list with work left in it after a finished plan is a new plan.
 */
export function mergePlan(
	prev: PlanDetails | null,
	prevWasDone: boolean,
	title: string | undefined,
	incoming: StepIn[],
): { plan: PlanDetails; fresh: boolean; justDone: string[]; wasDone: boolean } {
	const allDoneNow = allDone(incoming);
	const fresh = !prev || (prevWasDone && !allDoneNow);
	const old = fresh ? [] : prev.steps;
	const used = new Set<number>();
	const match = (step: StepIn) => {
		const i = old.findIndex((o, k) => !used.has(k) && o.text === step.text);
		if (i >= 0) used.add(i);
		return i >= 0 ? old[i] : undefined;
	};
	const justDone: string[] = [];
	const now = new Date().toISOString();
	const steps: PlanStep[] = incoming.map((step) => {
		const was = match(step);
		const out: PlanStep = { text: step.text, status: step.status };
		if (step.status === "completed") {
			out.doneAt = was?.status === "completed" && was.doneAt ? was.doneAt : now;
			if (was?.status !== "completed" && !fresh) justDone.push(step.text);
		}
		return out;
	});
	return {
		plan: { title: title?.trim() || (fresh ? "Plan" : prev.title), steps },
		fresh,
		justDone,
		wasDone: prevWasDone && !fresh,
	};
}

/** The plain copy that goes into tool result details (must survive session storage). */
export const snapshot = (plan: PlanDetails): PlanDetails => ({
	title: plan.title,
	steps: plan.steps.map((s) => ({ text: s.text, status: s.status, ...(s.doneAt ? { doneAt: s.doneAt } : {}) })),
});

/**
 * The plan state for one chat. Pi has no engine-side state store, so the plan lives in
 * the plan tool's result details and is rebuilt from the session branch — it follows
 * forks and /tree for free.
 */
export class PlanState {
	plan: PlanDetails | null = null;
	/** True once every step was done; a list with work left in it starts the next plan. */
	wasDone = false;
	/** False once a finished plan has held at 100% long enough, or for an empty list. */
	shown = false;

	reset() {
		this.plan = null;
		this.wasDone = false;
		this.shown = false;
	}

	/** Adopt a plan read back from the branch; a finished one does not redraw. */
	adopt(details: PlanDetails) {
		if (!details || !Array.isArray(details.steps)) return;
		this.plan = { title: typeof details.title === "string" && details.title ? details.title : "Plan", steps: details.steps };
		this.wasDone = allDone(details.steps);
		this.shown = details.steps.length > 0 && !this.wasDone;
	}

	/** Apply a whole new list from the model; reports what to toast. */
	apply(title: string | undefined, incoming: StepIn[]): { justDone: string[]; fresh: boolean } {
		const merged = mergePlan(this.plan, this.wasDone, title, incoming);
		this.plan = merged.plan;
		this.wasDone = allDone(incoming);
		this.shown = incoming.length > 0;
		return { justDone: merged.justDone, fresh: merged.fresh };
	}

	/** The bar draws while there is a plan with steps the user should see. */
	get visible(): boolean {
		return !!this.plan && this.plan.steps.length > 0 && this.shown;
	}

	hasLivePlan(): boolean {
		return !!this.plan && !this.wasDone && this.plan.steps.length > 0;
	}
}
