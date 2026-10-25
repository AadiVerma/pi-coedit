/** The clock face: remaining time, its state, and the ttl argument parser. */

export const FIVE_MIN = 5 * 60_000;

export function formatRemaining(ms: number): string {
	const t = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	const two = (n: number) => String(n).padStart(2, "0");
	return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export type CacheState = "warm" | "cooling" | "cold";

/** Warm while at least half the window remains, cooling down to a tenth, cold after. */
export function stateOf(msLeft: number, ttl: number): CacheState {
	if (msLeft <= 0 || ttl <= 0) return "cold";
	const ratio = msLeft / ttl;
	if (ratio >= 0.5) return "warm";
	if (ratio >= 0.1) return "cooling";
	return "cold";
}

export function parseTtl(arg: string | undefined): number | undefined {
	const m = /^(\d+)(m|h)$/.exec(arg ?? "");
	if (!m) return undefined;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return undefined; // "0m" is no window at all
	return m[2] === "h" ? n * 60 * 60_000 : n * 60_000;
}
