/**
 * pi-cache-clock — a countdown above the prompt until the prompt cache goes cold.
 *
 * Ported from the Cache Clock mod for Claude Code. Every provider response restarts
 * the countdown (5 minutes by default, /cache-clock 1h widens it); a widget above the
 * editor counts it down through warm, cooling and cold. /cache-clock warm forces pi's
 * cache warming on so the cache never goes cold; hide/show control the widget.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatRemaining, parseTtl, stateOf, FIVE_MIN, type CacheState } from "./clock.ts";

const WIDGET_KEY = "cache-clock:countdown";
const TICK_MS = 1_000;

const COLORS: Record<CacheState, [number, number, number]> = {
	warm: [22, 163, 74], // green
	cooling: [202, 138, 4], // amber
	cold: [37, 99, 235], // blue
};

export interface ClockState {
	lastAt: number;
	ttlMs: number;
	visible: boolean;
	keepWarm: boolean;
}

/** The widget face: `● cache 4:12`, colored by state. */
export class Countdown implements Component {
	private state: ClockState;
	private theme: Theme;
	private now: () => number;
	private cachedNow?: number;
	private cachedLines?: string[];

	constructor(state: ClockState, theme: Theme, now: () => number) {
		this.state = state;
		this.theme = theme;
		this.now = now;
	}

	invalidate(): void {
		this.cachedNow = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const now = this.now();
		if (this.cachedLines && this.cachedNow === now) return this.cachedLines;
		this.cachedNow = now;
		const left = this.state.lastAt + this.state.ttlMs - now;
		const state = stateOf(left, this.state.ttlMs);
		const [r, g, b] = COLORS[state];
		const line = `  \x1b[38;2;${r};${g};${b}m●\x1b[0m ${this.theme.fg("muted", "cache")} ${this.theme.fg("text", formatRemaining(left))}${this.state.keepWarm ? this.theme.fg("dim", " · kept warm") : ""}`;
		this.cachedLines = [truncateToWidth(line, width)];
		return this.cachedLines;
	}
}

export function createCacheClock(pi: ExtensionAPI) {
	const state: ClockState = { lastAt: 0, ttlMs: FIVE_MIN, visible: true, keepWarm: false };
	let ticker: ReturnType<typeof setInterval> | null = null;
	let uiCtx: any;

	const refresh = () => {
		if (!uiCtx?.hasUI) return;
		try {
			if (state.visible && state.lastAt) {
				uiCtx.ui.setWidget(WIDGET_KEY, (_tui: unknown, theme: Theme) => new Countdown(state, theme, () => Date.now()), {
					placement: "aboveEditor",
				});
			} else {
				uiCtx.ui.setWidget(WIDGET_KEY, undefined);
			}
		} catch {
			// A UI without widgets just skips the clock.
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		refresh();
		// The countdown moves on its own; the tick only runs while a session is live.
		if (!ticker) {
			ticker = setInterval(refresh, TICK_MS);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ticker) {
			clearInterval(ticker);
			ticker = null;
		}
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Nothing to clean up without a widget.
		}
	});

	pi.on("after_provider_response", async (_event, ctx) => {
		uiCtx = ctx;
		state.lastAt = Date.now();
		refresh();
	});

	// Keep-warm: when the switch is on, every warming decision is overridden to warm.
	pi.on("cache_warming_decision", async () => {
		return state.keepWarm ? { action: "warm" as const } : undefined;
	});

	pi.registerCommand("cache-clock", {
		description: "Cache clock: bare toggles the widget, 5m/1h set the ttl, warm toggles keep-warm, hide/show",
		handler: async (args: string, ctx) => {
			uiCtx = ctx;
			const arg = args.trim();
			if (arg === "warm") {
				state.keepWarm = !state.keepWarm;
				ctx.ui.notify(state.keepWarm ? "Keep warm is on: the cache is refreshed before it goes cold." : "Keep warm is off.", "info");
			} else if (arg === "hide" || arg === "show") {
				state.visible = arg === "show";
			} else if (parseTtl(arg) !== undefined) {
				state.ttlMs = parseTtl(arg)!;
				ctx.ui.notify(`Cache ttl set to ${arg}.`, "info");
			} else if (arg) {
				ctx.ui.notify(`Unknown argument "${arg}". Use 5m, 1h, warm, hide or show.`, "warning");
			} else {
				state.visible = !state.visible;
			}
			refresh();
		},
	});

	return {
		state,
		get ttlMs() {
			return state.ttlMs;
		},
	};
}

export default function cacheClock(pi: ExtensionAPI) {
	return createCacheClock(pi);
}
