import type { Author } from "./types.ts";

/**
 * Who changed a file — the documented detection rules (README §detection, docs/PLAN.md §1).
 *
 * 1. The editor sensor is authoritative *outside* agent tool windows: a keystroke
 *    edit it reports is `human`.
 * 2. A change detected inside an agent bash window with no editor report is `agent`.
 * 3. A human change landing during an agent bash window (editor reports human
 *    typing while the window is open) is `unknown` — never guessed, shown grey.
 * 4. Anything else is `human` (fs-watch outside windows, turn-start snapshots).
 */
export function classifyChange(opts: { editorSeenHuman: boolean; inAgentWindow: boolean }): Author {
	if (opts.editorSeenHuman) return opts.inAgentWindow ? "unknown" : "human";
	if (opts.inAgentWindow) return "agent";
	return "human";
}
