import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { HelperStore, type Helper } from "./helpers.ts";
import { piPet, nextFrame, HUES } from "./pet.ts";
import type { PlanState } from "./plan.ts";
import { doneCount } from "./plan.ts";
import type { FeedItem } from "./types.ts";
import { KIND_COLOR, type StepKind } from "./describe.ts";

const FEED_SHOWN = 8;
// The pet takes 24 columns (12 pixels, 2 cells each) plus a 2 column gap.
const PET_W = 26;

/** Claude's group-ink for the yellow heading (dark text on yellow). */
const INK = [28, 25, 23];

const fgHex = (hex: string, text: string) => {
	const n = hex.replace("#", "");
	const rgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`;
};
const bg = (rgb: number[], text: string) => `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`;
const hexRgb = (hex: string): number[] => {
	const n = hex.replace("#", "");
	return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
};

export interface PaneDeps {
	state: PlanState;
	helpers: HelperStore;
	feed: FeedItem[];
	theme: Theme;
	done: () => void;
	/** The clock, injectable so tests can step time. */
	now: () => number;
}

/**
 * The /helpers screen, in the Claude mod's side-pane style: the plan as a checklist,
 * then one live pet card per subagent under colored group headings, then the chat's
 * tool calls as a kind-colored step feed. Escape closes.
 */
export class HelpersPane {
	private deps: PaneDeps;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(deps: PaneDeps) {
		this.deps = deps;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.deps.done();
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

	private rule(label: string, width: number): string {
		const head = ` ${label} `;
		return truncateToWidth(
			this.deps.theme.fg("borderMuted", "─".repeat(3)) +
				this.deps.theme.fg("accent", head) +
				this.deps.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 6 - head.length))),
			width,
		);
	}

	private group(label: string, members: Helper[], hex: string, ink: number[], width: number): string[] {
		if (!members.length) return [];
		const text = ` ${label} · ${members.length} `;
		const pad = " ".repeat(Math.max(0, width - text.length));
		const inkText = `\x1b[38;2;${ink[0]};${ink[1]};${ink[2]}m${text}\x1b[0m`;
		return [truncateToWidth(bg(hexRgb(hex), `${inkText}${pad}`), width), ...members.flatMap((h) => this.card(h, width))];
	}

	private card(h: Helper, width: number): string[] {
		const now = this.deps.now();
		const live = h.status === "running";
		const frame = live ? nextFrame(now) : 0;
		const pet = piPet(h.hue, frame);
		const hue = HUES[((h.hue % HUES.length) + HUES.length) % HUES.length];
		const fgHue = (text: string) => `\x1b[38;2;${hue.color[0]};${hue.color[1]};${hue.color[2]}m${text}\x1b[0m`;

		const mark = live ? "●" : h.status === "done" ? "✓" : "✗";
		const markColor = live ? fgHue(mark) : h.status === "done" ? fgHex("#16a34a", mark) : fgHex("#dc2626", mark);
		const statusWord = live ? "Running" : h.status === "done" ? "Done" : "Stopped";
		const meta = `${statusWord} · ${HelperStore.elapsed(h, now)} · ${hue.name}`;
		const textW = Math.max(10, width - PET_W - 2);
		const pad = (s: string) => " ".repeat(Math.max(0, PET_W - s.length));

		const rows: string[] = [];
		for (let y = 0; y < pet.length; y++) {
			let right = "";
			if (y === 0) right = `${markColor} ${truncateToWidth(this.deps.theme.fg("text", h.label), textW - 2)}`;
			else if (y === 1) right = this.deps.theme.fg("dim", truncateToWidth(meta, textW));
			rows.push(truncateToWidth(`${pet[y]}${pad(pet[y])}  ${right}`, width));
		}
		return rows;
	}

	private draw(width: number): string[] {
		const th = this.deps.theme;
		const lines: string[] = [];
		const dim = (s: string) => th.fg("dim", s);

		lines.push("");
		lines.push(this.rule("Helper Desk", width));

		const plan = this.deps.state.plan;
		if (!plan || !plan.steps.length) {
			lines.push(truncateToWidth(`  ${dim("No plan yet. The agent saves one with its plan tool.")}`, width));
		} else {
			const done = doneCount(plan.steps);
			lines.push(truncateToWidth(`  ${th.fg("muted", `${plan.title}  ·  ${done}/${plan.steps.length} done`)}`, width));
			for (const step of plan.steps) {
				const mark =
					step.status === "completed"
						? th.fg("success", "✓")
						: step.status === "in_progress"
							? th.fg("accent", "●")
							: dim("○");
				const text = step.status === "completed" ? dim(step.text) : th.fg("text", step.text);
				lines.push(truncateToWidth(`  ${mark} ${text}`, width));
			}
		}

		const helpers = this.deps.helpers;
		if (helpers.all.length) {
			lines.push("");
			lines.push(this.rule("Subagents", width));
			lines.push(...this.group("Running", helpers.running, "#16a34a", [255, 255, 255], width));
			lines.push(...this.group("Finished", helpers.finished, "#eab308", INK, width));
			lines.push(...this.group("Stopped", helpers.stopped, "#dc2626", [255, 255, 255], width));
		}

		lines.push("");
		lines.push(this.rule("Steps this chat", width));
		const feed = this.deps.feed;
		if (!feed.length) {
			lines.push(truncateToWidth(`  ${dim("Tool calls show up here as they happen.")}`, width));
		} else {
			for (const item of feed.slice(-FEED_SHOWN)) {
				const kind = (KIND_COLOR as Record<string, string>)[item.kind] ? item.kind : "Tool";
				const mark = item.error ? fgHex("#dc2626", "✗") : item.done ? th.fg("success", "·") : th.fg("accent", "▸");
				const color = KIND_COLOR[kind as StepKind];
				const text = item.done && !item.error ? th.fg("muted", item.label) : th.fg("text", item.label);
				lines.push(truncateToWidth(`  ${mark} ${fgHex(color, text)}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${dim("Press Escape to close")}`, width));
		lines.push("");
		return lines;
	}
}
