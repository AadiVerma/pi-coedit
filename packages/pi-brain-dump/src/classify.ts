/**
 * The gate: decides whether a prompt is long and loose enough to be caught, and what
 * to ask about. Mechanical heuristics, as in the Claude mod — no model calls.
 */

const LONG_WORDS = 25;

/** Rough word count over whitespace, so newlines and tabs count as one separator. */
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

export const looksLong = (text: string) => words(text) >= LONG_WORDS;

export const isCommand = (text: string) => /^\s*\//.test(text);

const STRUCTURED = /##\s*(the job|the why|guardrails|done means)\b/i;
export const alreadyStructured = (text: string) => STRUCTURED.test(text);

export const shouldIntercept = (text: string) => looksLong(text) && !isCommand(text) && !alreadyStructured(text);

// ---- Signal detectors: a question is only asked when its signal is missing ----

const FILEISH = /(\.[a-z]{1,5}\b|(^|\s)(src|lib|test|tests|docs|bin)\b|\/[a-z-]+\/|["\'][^"\']+["\']|\b(files?|folders?|director(y|ies)|module|package|component)\b)/i;
const WHYISH = /\b(because|so that|for the|in order to|motivat|reason|background:)\b/i;
const GUARDRAILISH = /\b(don'?t|do not|never|avoids?|avoiding|without|keep|preserve|must not|no new|careful|only)\b/i;
const DONEISH = /\b(so that|done|finished|complete[sd]?|result|output|summary|write (it |the .+ )?to|should (be|pass|work)|tests? (must )?pass|pass(es|ed)?|ship|deliver)\b/i;

export type QuestionKind = "scope" | "why" | "guardrails" | "done";

export interface GapQuestion {
	kind: QuestionKind;
	question: string;
}

/** One question per missing signal, at most three, in the brief's own order. */
export function gapQuestions(text: string): GapQuestion[] {
	const all: GapQuestion[] = [];
	if (!FILEISH.test(text)) all.push({ kind: "scope", question: "Which files or parts of the repo should this touch?" });
	if (!WHYISH.test(text)) all.push({ kind: "why", question: "Why does this matter — any context the prompt leaves out?" });
	if (!GUARDRAILISH.test(text)) all.push({ kind: "guardrails", question: "Any guardrails — anything to avoid or keep unchanged?" });
	if (!DONEISH.test(text)) all.push({ kind: "done", question: "What does done look like — what should exist or be true at the end?" });
	return all.slice(0, 3);
}
