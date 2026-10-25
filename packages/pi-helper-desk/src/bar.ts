import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PlanState } from "./plan.ts";
import { doneCount } from "./plan.ts";

// The task bar is a purple gradient, light at the start and deep at the head
// (after Johnny's Savvy Progress, as in the original Helper Desk).
const P_LIGHT = [196, 181, 253]; // #c4b5fd
const P_MID = [139, 92, 246]; // #8b5cf6
const P_DEEP = [109, 40, 217]; // #6d28d9

const fg = (rgb: number[]) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const mix = (a: number[], b: number[], t: number): [number, number, number] =>
	[0, 1, 2].map((i) => Math.round((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * t)) as [number, number, number];

/** The visible width of a string with its ANSI escapes stripped. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The bar above the prompt: dot, title, purple gradient of blocks, Tasks n/m, percent,
 * and a dim line with the step in progress. Rendered to the width it is given.
 */
export class PlanBar implements Component {
	private readonly state: PlanState;
	private readonly theme: Theme;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(state: PlanState, theme: Theme) {
		this.state = state;
		this.theme = theme;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;

		const plan = this.state.plan;
		if (!plan || !plan.steps.length) {
			this.cachedLines = [];
			return this.cachedLines;
		}

		const n = plan.steps.length;
		const done = doneCount(plan.steps);
		const live = plan.steps.find((s) => s.status === "in_progress");
		const nextUp = plan.steps.find((s) => s.status === "pending");
		const finished = done === n;

		// Width budget: dot + title + bar + label + percent. The title gives way first.
		const label = `Tasks ${done}/${n}`;
		const pct = `${Math.round((done / n) * 100)}%`;
		const titleMax = Math.max(6, Math.min(28, plain(plan.title).length, Math.floor(width / 3)));
		const title = plan.title.length > titleMax ? `${plan.title.slice(0, titleMax - 1)}…` : plan.title;
		const barW = Math.max(6, width - title.length - label.length - pct.length - 8);

		// Filled cells shade from light purple to deep; a live step shimmers as a mid-purple piece.
		const fillC = Math.round((barW * done) / n);
		const liveC = live ? Math.max(0, Math.round((barW * Math.min(n, done + 1)) / n) - fillC) : 0;
		let bar = "";
		for (let i = 0; i < fillC; i++) {
			const t = fillC > 1 ? i / (fillC - 1) : 1;
			bar += `${fg(mix(P_LIGHT, P_DEEP, t))}█`;
		}
		if (liveC) bar += `${fg(P_MID)}${"▓".repeat(liveC)}`;
		bar += `${this.theme.fg("dim", "░".repeat(Math.max(0, barW - fillC - liveC)))}`;
		bar += RESET;

		const line1 = truncateToWidth(
			`${fg(P_DEEP)}●${RESET} ${BOLD}${title}${RESET} ${bar} ${fg(P_MID)}${label}${RESET} ${DIM}${pct}${RESET}`,
			width,
		);

		const line2 = live
			? this.theme.fg("accent", `Now: ${live.text}`)
			: finished
				? this.theme.fg("success", "All steps done")
				: nextUp
					? this.theme.fg("dim", `Next: ${nextUp.text}`)
					: "";

		this.cachedLines = line2 ? [line1, truncateToWidth(line2, width)] : [line1];
		return this.cachedLines;
	}
}

/** The factory handed to ctx.ui.setWidget; it reads the live state at render time. */
export const barFactory =
	(state: PlanState) =>
	(_tui: unknown, theme: Theme) =>
		new PlanBar(state, theme);
