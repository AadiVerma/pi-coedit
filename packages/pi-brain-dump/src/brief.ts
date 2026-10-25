/**
 * The four-part brief: the job, the why, the guardrails, done means — the shape the
 * Claude mod's Brain Dump fills the prompt box with.
 */

export const FOUR_PARTS = ["The job", "The why", "Guardrails", "Done means"] as const;

export interface BriefAnswers {
	/** A scope answer is appended to the job: "Scope: …" */
	scope?: string;
	why?: string;
	guardrails?: string;
	done?: string;
}

const oneLine = (a: string | undefined) => (typeof a === "string" ? a.replace(/\s+/g, " ").trim() : "");

const FALLBACKS = {
	why: "Not specified — use your judgment.",
	guardrails: "None given — nothing is off limits.",
	done: "Not specified — propose what done looks like.",
};

/**
 * The original prompt becomes the job verbatim (with a Scope line when the user named
 * one); each answer fills its section, with an honest fallback where the user skipped.
 * The output is always structured, so the classifier never catches a brief twice.
 */
export function buildBrief(prompt: string, answers: BriefAnswers = {}): string {
	const job = prompt.trim();
	const scope = oneLine(answers.scope);
	const parts = [`## The job\n${job}${scope ? `\n\nScope: ${scope}` : ""}`];
	parts.push(`## The why\n${oneLine(answers.why) || FALLBACKS.why}`);
	parts.push(`## Guardrails\n${oneLine(answers.guardrails) || FALLBACKS.guardrails}`);
	parts.push(`## Done means\n${oneLine(answers.done) || FALLBACKS.done}`);
	return `${parts.join("\n\n")}\n`;
}
