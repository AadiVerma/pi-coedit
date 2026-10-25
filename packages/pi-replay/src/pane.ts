import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { EditStep } from "./edits.ts";

/** The theater: one diff at a time, stepped with the arrow keys, closed with escape. */
export class ReplayPane {
	private steps: EditStep[];
	private theme: Theme;
	private done: () => void;
	private index = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(steps: EditStep[], theme: Theme, done: () => void) {
		this.steps = steps;
		this.theme = theme;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "right") || data === "l") {
			this.index = Math.min(this.steps.length - 1, this.index + 1);
			this.invalidate();
		} else if (matchesKey(data, "left") || data === "h") {
			this.index = Math.max(0, this.index - 1);
			this.invalidate();
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.draw(width);
		return this.cachedLines;
	}

	private draw(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const rule = (label: string) => {
			const head = ` ${label} `;
			return truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) + th.fg("accent", head) + th.fg("borderMuted", "─".repeat(Math.max(0, width - 6 - head.length))),
				width,
			);
		};

		lines.push("");
		lines.push(rule("Replay Theater"));

		if (!this.steps.length) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No file edits in this chat yet.")}`, width));
		} else {
			const step = this.steps[this.index];
			lines.push(
				truncateToWidth(`  ${th.fg("text", step.path)}  ${th.fg("muted", `${this.index + 1} of ${this.steps.length}`)}`, width),
			);
			lines.push("");
			for (const line of step.diff.split("\n")) {
				const style = line.startsWith("+") ? th.fg("success", line) : line.startsWith("-") ? th.fg("error", line) : th.fg("text", line);
				lines.push(truncateToWidth(`  ${style}`, width));
			}
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", "← → step · escape closes")}`, width));
		}
		lines.push("");
		return lines;
	}
}
