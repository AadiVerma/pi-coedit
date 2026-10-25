/**
 * The screen mask: replaces sensitive strings with blocks while you record. Hostnames
 * of URLs stay (so links still read), code stays (it is the work), everything sensitive
 * in prose goes. Idempotent: masked output never matches the patterns again.
 */

const BLOCK = "█";

const blockOut = (match: string, keep = 0): string => {
	const visible = keep ? match.slice(0, keep) : "";
	return visible + BLOCK.repeat(Math.max(3, match.length - visible.length));
};

/** Sensitive patterns, in the order they are applied. */
const PATTERNS: { re: RegExp; keep?: number }[] = [
	// Emails: keep nothing.
	{ re: /\b[\w.%-]+@[\w-]+(\.[\w-]+)+\b/g },
	// Credit-card-shaped: 13-19 digits with spaces or dashes.
	{ re: /\b(?:\d[ -]?){12,18}\d\b/g },
	// IPv4.
	{ re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
	// Phone-ish: +country with separators or dense, and US shapes with . - or space.
	{ re: /\+\d{1,3}(?:[ -]\d{2,4}){2,4}\b/g },
	{ re: /\+\d{8,15}\b/g },
	{ re: /\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g },
	{ re: /\b\d{10}\b/g },
	// Money amounts with separators or decimals; a single digit ($0, $5) still masks.
	{ re: /[$€£]\s?\d(?:[\d.,]*\d)?/g },
	{ re: /\b\d(?:[\d.,]*\d)?\s?(?:USD|EUR|GBP)\b/g },
	// URLs: keep scheme+host, mask the rest.
	{ re: /https?:\/\/[^\s)]+/g, keep: -1 },
];

function maskUrl(url: string): string {
	const m = /^([a-z]+:\/\/[^/?#]+)(\/.*)?$/i.exec(url);
	if (!m) return blockOut(url);
	const rest = m[2] ?? "";
	return `${m[1]}${rest ? BLOCK.repeat(Math.max(3, rest.length)) : ""}`;
}

export function maskSensitive(text: string): string {
	if (!text) return text;
	// Protect fenced code blocks (an unclosed fence holds to the end) and inline code;
	// mask only the prose between them.
	const parts = text.split(/(```[\s\S]*?```|```[\s\S]*$|`[^`\n]+`)/g);
	return parts
		.map((part, i) => {
			if (i % 2 === 1) return part; // code stays
			let out = part;
			for (const { re, keep } of PATTERNS) {
				out = out.replace(re, (match) => (keep === -1 ? maskUrl(match) : blockOut(match, keep ?? 0)));
			}
			return out;
		})
		.join("");
}
