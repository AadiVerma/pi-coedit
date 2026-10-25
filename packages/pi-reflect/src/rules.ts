import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const RULES_HEADER = "## Rules";
const bullet = (rule: string) => `- ${rule}`;

/** The rules already saved in the file, in order; [] when there is none. */
export function readRules(file: string): string[] {
	if (!existsSync(file)) return [];
	const body = readFileSync(file, "utf8");
	const section = body.split(/^## Rules\s*$/m)[1];
	if (!section) return [];
	return (section.match(/^- .+$/gm) ?? []).map((line) => line.replace(/^- /, "").trim()).filter(Boolean);
}

/** Append the rule under the Rules section, creating file and section as needed. Idempotent. */
export function appendRule(file: string, rule: string): void {
	const clean = rule.trim().replace(/\s+/g, " ");
	const body = existsSync(file) ? readFileSync(file, "utf8") : "# AGENTS.md\n";
	let next: string;
	if (body.includes(RULES_HEADER)) {
		const { head, tail } = splitSections(body);
		const rules = readRules(file);
		if (rules.some((r) => r.toLowerCase() === clean.toLowerCase())) return;
		next = `${head}${RULES_HEADER}\n\n${[...rules, clean].map(bullet).join("\n")}\n${tail}`;
	} else {
		next = `${body.trimEnd()}\n\n${RULES_HEADER}\n\n${bullet(clean)}\n`;
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next);
}

/** Split an AGENTS.md that already has a Rules section into head and tail (the tail starts at the next "## " header, if any). */
function splitSections(body: string): { head: string; tail: string } {
	const at = body.indexOf(RULES_HEADER);
	if (at < 0) return { head: body, tail: "" };
	const head = body.slice(0, at);
	const rest = body.slice(at + RULES_HEADER.length);
	const nextHeader = rest.search(/^## /m);
	return nextHeader < 0 ? { head, tail: "" } : { head, tail: rest.slice(nextHeader) };
}
