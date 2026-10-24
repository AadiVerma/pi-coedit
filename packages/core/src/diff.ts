import type { Hunk } from "./types.ts";
import { lineEquals } from "./util.ts";

/**
 * Line diff, dependency-free. Myers O(ND) on the (prefix/suffix-trimmed) middle
 * section; when the edit distance exceeds MAX_PATH the middle section is treated
 * as one full replace hunk, which keeps memory bounded on pathological inputs.
 * Comparison is CRLF-agnostic (trailing \r is ignored).
 */

const MAX_PATH = 8000;

interface Op {
	type: "eq" | "del" | "ins";
	/** index into before (del/eq) */
	a: number;
	/** index into after (ins/eq) */
	b: number;
}

/** Myers shortest edit script. before/after must be the already-trimmed middle sections. */
function myersScript(before: string[], after: string[]): Op[] {
	const n = before.length;
	const m = after.length;
	const max = n + m;
	if (max === 0) return [];
	const offset = max;
	const v = new Int32Array(2 * max + 1);
	const trace: Int32Array[] = [];
	const eq = (a: number, b: number) => lineEquals(before[a], after[b]);

	let foundD = -1;
	outer: for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
				x = v[offset + k + 1]; // down (insert)
			} else {
				x = v[offset + k - 1] + 1; // right (delete)
			}
			let y = x - k;
			while (x < n && y < m && eq(x, y)) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				foundD = d;
				break outer;
			}
		}
	}
	if (foundD < 0) return []; // unreachable

	// Backtrack
	const ops: Op[] = [];
	let x = n;
	let y = m;
	for (let d = foundD; d > 0; d--) {
		const vPrev = trace[d];
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = vPrev[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ type: "eq", a: x - 1, b: y - 1 });
			x--;
			y--;
		}
		if (x === prevX) {
			ops.push({ type: "ins", a: x, b: y - 1 });
			y--;
		} else {
			ops.push({ type: "del", a: x - 1, b: y });
			x--;
		}
	}
	while (x > 0 && y > 0) {
		ops.push({ type: "eq", a: x - 1, b: y - 1 });
		x--;
		y--;
	}
	while (x > 0) {
		ops.push({ type: "del", a: x - 1, b: y });
		x--;
	}
	while (y > 0) {
		ops.push({ type: "ins", a: x, b: y - 1 });
		y--;
	}
	ops.reverse();
	return ops;
}

/** Hunks with zero context, in file order. */
export function computeHunks(before: string[], after: string[]): Hunk[] {
	// Trim common prefix / suffix first: cheap, and makes the common case O(n).
	let start = 0;
	const minLen = Math.min(before.length, after.length);
	while (start < minLen && lineEquals(before[start], after[start])) start++;
	let endB = before.length;
	let endA = after.length;
	while (endB > start && endA > start && lineEquals(before[endB - 1], after[endA - 1])) {
		endB--;
		endA--;
	}
	const midB = before.slice(start, endB);
	const midA = after.slice(start, endA);

	const hunks: Hunk[] = [];
	if (midB.length + midA.length > MAX_PATH) {
		if (midB.length > 0 || midA.length > 0) {
			hunks.push({ delStart: start, delCount: midB.length, insStart: start, insCount: midA.length });
		}
		return hunks;
	}

	const ops = myersScript(midB, midA);
	let delStart = -1;
	let delCount = 0;
	let insCount = 0;
	let insStart = -1;
	let shift = 0; // lines added by hunks already emitted (after-coords vs before-coords)
	const flush = () => {
		if (delStart >= 0) {
			const insPos = insStart < 0 ? delStart + shift : insStart; // pure deletion
			hunks.push({ delStart: start + delStart, delCount, insStart: start + insPos, insCount });
			shift += insCount - delCount;
			delStart = -1;
			delCount = 0;
			insCount = 0;
			insStart = -1;
		}
	};
	for (const op of ops) {
		if (op.type === "eq") {
			flush();
		} else {
			if (delStart < 0) delStart = op.a;
			if (op.type === "del") delCount++;
			else {
				if (insStart < 0) insStart = op.b;
				insCount++;
			}
		}
	}
	flush();
	return hunks;
}

/** Unified-diff-style text for humans (0 context), bounded to `maxLines`. */
export function formatHunks(before: string[], after: string[], hunks: Hunk[], maxLines = 400): string {
	const out: string[] = [];
	let used = 0;
	let truncated = false;
	for (const h of hunks) {
		if (used >= maxLines) {
			truncated = true;
			break;
		}
		const del = before.slice(h.delStart, h.delStart + h.delCount);
		const ins = after.slice(h.insStart, h.insStart + h.insCount);
		out.push(`@@ -${h.delStart + 1},${h.delCount} +${h.insStart + 1},${h.insCount} @@`);
		used++;
		for (const l of del) {
			if (used >= maxLines) {
				truncated = true;
				break;
			}
			out.push(`-${l.replace(/\r$/, "")}`);
			used++;
		}
		for (const l of ins) {
			if (used >= maxLines) {
				truncated = true;
				break;
			}
			out.push(`+${l.replace(/\r$/, "")}`);
			used++;
		}
	}
	if (truncated) out.push("… (truncated)");
	return out.join("\n");
}
