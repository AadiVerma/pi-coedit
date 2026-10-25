import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Inventory } from "./inventory.ts";

/** A "Label · n" heading is drawn only when the group has members. */
export class InventoryPane {
	private readonly inv: Inventory;
	private readonly theme: Theme;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(inv: Inventory, theme: Theme) {
		this.inv = inv;
		this.theme = theme;
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
			this.theme.fg("borderMuted", "─".repeat(3)) +
				this.theme.fg("accent", head) +
				this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 6 - head.length))),
			width,
		);
	}

	private group(label: string, items: string[], width: number): string[] {
		if (!items.length) return [];
		const lines = [truncateToWidth(`  ${this.theme.fg("muted", `${label} (${items.length})`)}`, width)];
		for (const item of items.slice(0, 12)) {
			lines.push(truncateToWidth(`    ${this.theme.fg("text", "·")} ${this.theme.fg("text", item)}`, width));
		}
		if (items.length > 12) lines.push(truncateToWidth(`    ${this.theme.fg("dim", `… ${items.length - 12} more`)}`, width));
		return lines;
	}

	private draw(width: number): string[] {
		const inv = this.inv;
		const lines: string[] = [];
		const dim = (s: string) => this.theme.fg("dim", s);

		lines.push("");
		lines.push(this.rule("Chat Inventory", width));
		const status = [`  ${this.theme.fg("text", `${inv.prompts} prompt${inv.prompts === 1 ? "" : "s"}`)}`, this.theme.fg("muted", " · "), `${inv.toolCalls} tool call${inv.toolCalls === 1 ? "" : "s"}`];
		if (inv.errors) status.push(this.theme.fg("error", ` · ${inv.errors} error${inv.errors === 1 ? "" : "s"}`));
		lines.push(truncateToWidth(status.join(""), width));

		if (inv.plan) lines.push(truncateToWidth(`  ${this.theme.fg("accent", `${inv.plan.title} · ${inv.plan.done}/${inv.plan.total} done`)}`, width));

		lines.push("");
		lines.push(this.rule("Files", width));
		if (!inv.files.read.length && !inv.files.written.length) {
			lines.push(truncateToWidth(`  ${dim("No files touched yet.")}`, width));
		} else {
			lines.push(...this.group("Read", inv.files.read, width));
			lines.push(...this.group("Written", inv.files.written, width));
		}

		lines.push("");
		lines.push(this.rule("Activity", width));
		if (!inv.commands.length && !inv.web.length && !inv.subagents.length && !inv.skills.length) {
			lines.push(truncateToWidth(`  ${dim("No tool calls yet.")}`, width));
		} else {
			lines.push(...this.group("Commands", inv.commands, width));
			lines.push(...this.group("Web", inv.web, width));
			lines.push(...this.group("Subagents", inv.subagents, width));
			lines.push(...this.group("Skills", inv.skills, width));
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${dim("Press Escape to close")}`, width));
		lines.push("");
		return lines;
	}
}
