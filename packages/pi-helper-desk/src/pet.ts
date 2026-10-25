/**
 * The pi pets: a pixel π mascot, one body hue per subagent, drawn in ANSI blocks.
 * Ported from the Claude mod's crab pets: 8 hues that running helpers never share,
 * 4 frames (stand, hop, blink, kick) — a running pet cycles, a finished one stands.
 */

export const HUES: { name: string; color: [number, number, number] }[] = [
	{ name: "red", color: [220, 38, 38] }, // #dc2626
	{ name: "orange", color: [234, 88, 12] }, // #ea580c
	{ name: "yellow", color: [234, 179, 8] }, // #eab308
	{ name: "green", color: [22, 163, 74] }, // #16a34a
	{ name: "teal", color: [13, 148, 136] }, // #0d9488
	{ name: "blue", color: [37, 99, 235] }, // #2563eb
	{ name: "purple", color: [147, 51, 234] }, // #9333ea
	{ name: "pink", color: [219, 39, 119] }, // #db2777
];

/** Eyes and outline are the same on every pet, as in the Claude mod (#2b1d16). */
export const EYE: [number, number, number] = [0x2b, 0x1d, 0x16];

/** The pet's pixel grid; every pixel draws as two terminal columns (██). */
export const PET_COLS = 12;
export const PET_ROWS = 7;

/** A running pet changes frame every 600 ms. */
export const FRAME_MS = 600;
export const nextFrame = (t: number) => Math.floor(t / FRAME_MS) % 4;

type Px = [x: number, y: number];

const hueOf = (hue: number) => HUES[((hue % HUES.length) + HUES.length) % HUES.length];

const fg = (rgb: [number, number, number]) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const RESET = "\x1b[0m";

const span = (y: number, from: number, to: number): Px[] => Array.from({ length: to - from + 1 }, (_, i) => [from + i, y] as Px);

/**
 * One frame of the π on a 12 by 7 grid. The shape sits in rows 0..5 and the standing
 * frame shifts it down one, leaving row 0 free for the hop. Frame 0 stands; 1 hops up a
 * pixel; 2 stands and blinks; 3 kicks its feet outward.
 */
function piShape(frame: number): { body: Px[]; eyes: Px[] } {
	const hop = frame === 1;
	const blink = frame === 2;
	const kick = frame === 3;
	const dy = hop ? 0 : 1;
	let body: Px[] = [...span(0, 1, 10)];
	// Two stems under the bar.
	for (let y = 1; y <= 4; y++) body = [...body, ...span(y, 2, 4), ...span(y, 7, 9)];
	// Feet on the ground row; a kick reaches outward.
	const feetFrom = kick ? 1 : 2;
	const feetTo = kick ? 10 : 9;
	body = [...body, ...span(5, feetFrom, 4), ...span(5, 7, feetTo)];
	const eyes: Px[] = blink ? [] : [
		[3, 1],
		[8, 1],
	];
	return { body: body.map(([x, y]) => [x, y + dy] as Px), eyes: eyes.map(([x, y]) => [x, y + dy] as Px) };
}

const cache = new Map<string, string[]>();

/** The pet's lines, in `hue`'s body color, at `frame` (both wrap around). */
export function piPet(hue: number, frame: number): string[] {
	const h = ((hue % HUES.length) + HUES.length) % HUES.length;
	const f = ((frame % 4) + 4) % 4;
	const key = `${h}:${f}`;
	const hit = cache.get(key);
	if (hit) return hit;

	const { body, eyes } = piShape(f);
	const fill = hueOf(h).color;
	const has = new Set(body.map(([x, y]) => `${x},${y}`));
	const rows: string[] = [];
	for (let y = 0; y < PET_ROWS; y++) {
		let line = "";
		let drawn = false;
		// Gaps inside the row stay as spaces, so the two stems read separately;
		// trailing space is trimmed.
		const last = [...body].reverse().find(([, by]) => by === y);
		const rowEnd = last ? last[0] : -1;
		for (let x = 0; x <= rowEnd; x++) {
			if (!has.has(`${x},${y}`)) {
				line += "  ";
				continue;
			}
			const eye = eyes.some(([ex, ey]) => ex === x && ey === y);
			line += `${fg(eye ? EYE : fill)}██`;
			drawn = true;
		}
		rows.push(drawn ? `${line}${RESET}` : "");
	}
	cache.set(key, rows);
	return rows;
}

/** The next hue in order that no running helper wears; with all 8 taken, the next in order. */
export function pickHue(nextHue: number, runningHues: readonly number[]): number {
	const used = new Set(runningHues.map((h) => ((h % HUES.length) + HUES.length) % HUES.length));
	const start = ((nextHue % HUES.length) + HUES.length) % HUES.length;
	let hue = start;
	for (let i = 0; i < HUES.length; i++) {
		const candidate = (start + i) % HUES.length;
		if (!used.has(candidate)) {
			hue = candidate;
			break;
		}
	}
	return hue;
}
