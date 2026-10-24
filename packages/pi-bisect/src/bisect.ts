/**
 * Bisect engine: binary-searches a list of snapshot shas (oldest..newest) with a
 * caller-supplied pass/fail runner. The engine owns endpoint verification and
 * step accounting; the runner owns worktrees and command execution.
 */
export interface BisectProgress {
	step: number;
	lo: number;
	hi: number;
	testing: number;
	total: number;
}

export type BisectResult =
	| { ok: true; foundIndex: number; steps: number }
	| { ok: false; reason: string; steps: number };

export async function bisect(
	shas: string[],
	runCommand: (sha: string, index: number) => Promise<boolean>,
	onProgress?: (p: BisectProgress) => void,
): Promise<BisectResult> {
	if (shas.length === 0) return { ok: false, reason: "no shadow snapshots found for this session", steps: 0 };
	if (shas.length === 1) return { ok: false, reason: "only one shadow snapshot — nothing to bisect", steps: 0 };

	let steps = 0;
	const run = async (sha: string, index: number): Promise<boolean> => {
		steps++;
		const pass = await runCommand(sha, index);
		return pass;
	};

	// Endpoint verification: must pass at the oldest and fail at the newest.
	const oldestOk = await run(shas[0], 0);
	if (!oldestOk) return { ok: false, reason: "the command already fails at the OLDEST snapshot — bisect needs it to pass there (it never passed)", steps };
	const newestOk = await run(shas[shas.length - 1], shas.length - 1);
	if (newestOk) return { ok: false, reason: "the command already PASSES at the newest snapshot — nothing to bisect", steps };

	let lo = 0; // good
	let hi = shas.length - 1; // bad
	while (hi - lo > 1) {
		const mid = lo + Math.floor((hi - lo) / 2);
		onProgress?.({ step: steps + 1, lo, hi, testing: mid, total: shas.length });
		const midOk = await run(shas[mid], mid);
		if (midOk) lo = mid;
		else hi = mid;
	}
	onProgress?.({ step: steps, lo, hi, testing: hi, total: shas.length });
	return { ok: true, foundIndex: hi, steps };
}

/** Parse `5m` / `90s` / `4500` into ms. */
export function parseTimeout(s: string | undefined, fallbackMs = 300_000): number {
	if (!s) return fallbackMs;
	const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
	if (!m) return fallbackMs;
	const n = Number(m[1]);
	switch (m[2]) {
		case "ms":
			return n;
		case "s":
			return n * 1_000;
		case "m":
			return n * 60_000;
		case "h":
			return n * 3_600_000;
		default:
			return n;
	}
}
