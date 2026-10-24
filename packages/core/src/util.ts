import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function newId(): string {
	return randomBytes(8).toString("hex");
}

export function contentHash(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export function fileExists(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Atomic write: temp file in the same directory, then rename. */
export function atomicWrite(path: string, data: string | Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, data);
	renameSync(tmp, path);
}

/** First `max` chars, with an ellipsis marker when truncated. */
export function excerpt(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1)}…`;
}

/** Split content into lines: "\n"-separated, no trailing empty element, empty content -> []. */
export function splitLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Equality helper that treats CRLF and LF as equal (line-ending agnostic diffing). */
export function lineEquals(a: string, b: string): boolean {
	if (a === b) return true;
	if (a.endsWith("\r")) a = a.slice(0, -1);
	if (b.endsWith("\r")) b = b.slice(0, -1);
	return a === b;
}

export function isBinary(content: Buffer): boolean {
	const probe = content.subarray(0, 8192);
	return probe.includes(0);
}

export function toPosix(p: string): string {
	return p.split("\\").join("/");
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
