import { HUES, pickHue } from "./pet.ts";

export type HelperStatus = "running" | "done" | "stopped";

export interface Helper {
	/** The tool call id of the Agent launch. */
	id: string;
	label: string;
	status: HelperStatus;
	/** Which of the 8 hues its pet wears; running helpers never share one. */
	hue: number;
	/** Position in the desk, in start order. */
	seat: number;
	startedAt: number;
	endedAt?: number;
}

/**
 * The desk of subagent helpers. Pi has no engine-level subagent events, so the extension
 * feeds this store from Agent tool calls (@tintinweb/pi-subagents): one spawn per tool
 * call id, finished or stopped when its result lands.
 */
export class HelperStore {
	private items: Helper[] = [];
	private nextSeat = 0;
	/** The next hue to hand out, in HUES order. */
	private nextHue = 0;

	get all(): readonly Helper[] {
		return this.items;
	}

	get running(): Helper[] {
		return this.items.filter((h) => h.status === "running");
	}

	get finished(): Helper[] {
		return this.items.filter((h) => h.status === "done");
	}

	get stopped(): Helper[] {
		return this.items.filter((h) => h.status === "stopped");
	}

	find(id: string): Helper | undefined {
		return this.items.find((h) => h.id === id);
	}

	/** A new Agent launch, or a label update on one the desk already holds. */
	spawn(id: string, label: string, at: number): Helper {
		const known = this.find(id);
		if (known) {
			if (label) known.label = label;
			// A teammate that finished and picks up work again is working again.
			if (known.status !== "running") {
				known.status = "running";
				known.endedAt = undefined;
			}
			return known;
		}
		const hue = pickHue(this.nextHue, this.running.map((h) => h.hue));
		this.nextHue = hue + 1;
		const helper: Helper = { id, label, status: "running", hue, seat: this.nextSeat++, startedAt: at };
		this.items.push(helper);
		return helper;
	}

	/** The launch's result landed: done, or stopped when it errored. */
	finish(id: string, failed: boolean, at: number): Helper | undefined {
		const helper = this.find(id);
		if (!helper) return undefined;
		helper.status = failed ? "stopped" : "done";
		helper.endedAt = at;
		return helper;
	}

	/** The card's elapsed time: mm:ss from start to end, or to now while running. */
	static elapsed(helper: Helper, now: number): string {
		const end = helper.status === "running" ? now : (helper.endedAt ?? now);
		const t = Math.max(0, Math.floor((end - helper.startedAt) / 1000));
		const m = Math.floor(t / 60);
		const s = String(t % 60).padStart(2, "0");
		return `${m}:${s}`;
	}

	/** The hue's display name, for alt text and tests. */
	static hueName(helper: Helper): string {
		return HUES[((helper.hue % HUES.length) + HUES.length) % HUES.length].name;
	}

	clear() {
		this.items = [];
		this.nextSeat = 0;
		this.nextHue = 0;
	}
}
