/**
 * Correction detection: mechanical heuristics over the user's input. A correction is a
 * short interjection that pushes back on what the agent just did — never a question,
 * never a follow-up instruction, never a benign "no X" phrase.
 */

// Benign "no <word>" phrases that must not read as pushback.
const NO_EXCEPTION = /^\s*no\s+(worries|objections|problem|problems|thanks|hurry|rush|doubt)\b/i;

const STARTERS = [
	"no\\b(?![?])", // "no?" is a question
	"nope\\b",
	"nah\\b",
	"não\\b",
	"that'?s\\s+(?:wrong|incorrect|backwards|inverted|not\\s+(?:it|right|what)|the\\s+wrong)",
	"that\\s+is\\s+not\\s+right",
	"not\\b(?!\\s+only\\b)", // "not only..." continues a thought
	"actually[ ,!]",
	"i\\s+(?:said|told\\s+you|asked\\s+for)",
	"you\\s+(?:broke|missed|misunderstood|got|were\\s+supposed|should\\s+have)",
	"you'?(?:re|’re)\\s+(?:editing|on\\s+the\\s+wrong)",
	"wrong[ ,!]",
	"stop\\b",
	"undo\\b",
	"revert\\b",
	"don'?t\\b",
	"do\\s+not\\b",
	"wait,?\\s+no\\b",
	"hold\\s+on[ ,!]",
	"correction:?",
	"start\\s+over\\b",
	"go\\s+back\\b",
	"try\\s+again\\b",
	"again[,!]",
];

const CORRECTION = new RegExp(`^\\s*(?:${STARTERS.join("|")})`, "i");

/** A correction must push back first; later sentences carry the fix. */
export function isCorrection(text: string): boolean {
	if (!text.trim() || /^\s*\//.test(text)) return false;
	if (NO_EXCEPTION.test(text)) return false;
	return CORRECTION.test(text);
}

// Interjections that carry no meaning of their own; stripped from the suggestion.
// Negations (don't, never, not, do not) are KEPT — dropping them flips the rule.
const INTERJECTIONS = [
	"no\\b[,.!]*",
	"nope\\b[,.!]*",
	"nah\\b[,.!]*",
	"não\\b[,.!]*",
	"revert\\b[,.!\\s]*",
	"undo\\b[,.!\\s]*",
	"that'?s\\s+(?:wrong|incorrect|backwards|inverted|not\\s+(?:it|right|what)|the\\s+wrong)[,.!\\s-]*",
	"that\\s+is\\s+not\\s+right[,.!\\s-]*",
	"actually[ ,!]*",
	"i\\s+(?:said|told\\s+you|asked\\s+for)",
	"you\\s+(?:broke|missed|misunderstood|got|were\\s+supposed\\s+to|should\\s+have)",
	"you'?(?:re|’re)\\s+editing\\s+the\\s+wrong\\s+",
	"wrong[,.!]*",
	"stop[,.!]*",
	"wait,?\\s+no[,.!]*",
	"hold\\s+on[,.!]*",
	"correction:?",
	"start\\s+over[,.!]*",
	"go\\s+back[,.!]*",
	"try\\s+again[,.!]*",
	"again[,!]",
];

/** The rule candidate: the correction minus its interjection, tightened into one line. */
export function suggestRule(text: string): string {
	let body = text;
	let stripped = true;
	while (stripped) {
		stripped = false;
		for (const pattern of INTERJECTIONS) {
			const next = body.replace(new RegExp(`^\\s*${pattern}\\s*`, "i"), "");
			if (next !== body) {
				body = next;
				stripped = true;
			}
		}
	}
	body = body.replace(/^[—\-–,.\s]+/, "").trim();
	// A leftover pointing only at the previous change, or bare deixis, is not a
	// durable principle.
	if (
		!body ||
		body.length < 6 ||
		body.split(/\s+/).length < 2 ||
		/^(the|this|that|it)\s+(last|previous)\b/i.test(body) ||
		/^(that|this|it|those|these|everything)\b/i.test(body) ||
		/^(now|again|just|only)\b/i.test(body)
	) {
		body = "When asked, revert instead of editing on.";
	}
	const oneLine = `${body.replace(/\s+/g, " ").replace(/[.!?]*$/, "")}.`;
	return oneLine.charAt(0).toUpperCase() + oneLine.slice(1);
}
