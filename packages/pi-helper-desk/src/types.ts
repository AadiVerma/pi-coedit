export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
	text: string;
	status: PlanStatus;
	/** When the step was first marked completed, ISO format. */
	doneAt?: string;
}

/** What the plan tool stores in its result details; state reconstructs from this on the branch. */
export interface PlanDetails {
	title: string;
	steps: PlanStep[];
}

/** One line in the /helpers activity feed. */
export interface FeedItem {
	/** The tool call id, so its result can find it. */
	id: string;
	kind: string;
	label: string;
	/** True once its tool result came back. */
	done: boolean;
	/** True when the result came back as an error. */
	error?: boolean;
	at: number;
}
