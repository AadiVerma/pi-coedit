/**
 * What this chat used, scanned from the session branch: prompts, the plan, files,
 * commands, web sources, subagents, skills. Assistant messages carry the tool calls
 * (with arguments); tool results carry errors and the plan's details.
 */

export interface BranchEntry {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		toolCallId?: string;
		details?: unknown;
		isError?: boolean;
	};
}

export interface PlanSummary {
	title: string;
	done: number;
	total: number;
}

export interface Inventory {
	prompts: number;
	toolCalls: number;
	errors: number;
	files: { read: string[]; written: string[] };
	commands: string[];
	web: string[];
	subagents: string[];
	skills: string[];
	plan: PlanSummary | null;
}

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const arg = (a: unknown, key: string): string => {
	const v = (a as Record<string, unknown> | undefined)?.[key];
	return typeof v === "string" ? v : "";
};
const push = (list: string[], value: string) => {
	if (value && !list.includes(value)) list.push(value);
};

const readPlan = (details: unknown): PlanSummary | null => {
	const d = details as { title?: unknown; steps?: unknown } | undefined;
	if (!d || !Array.isArray(d.steps)) return null;
	const steps = d.steps.filter(
		(s): s is { status: string } => !!(s && typeof s === "object" && typeof (s as any).status === "string"),
	);
	return {
		title: typeof d.title === "string" && d.title ? d.title : "Plan",
		done: steps.filter((s) => s.status === "completed").length,
		total: steps.length,
	};
};

export function buildInventory(entries: BranchEntry[]): Inventory {
	const inv: Inventory = {
		prompts: 0,
		toolCalls: 0,
		errors: 0,
		files: { read: [], written: [] },
		commands: [],
		web: [],
		subagents: [],
		skills: [],
		plan: null,
	};

	for (const entry of entries) {
		const msg = entry.message;
		if (!msg) continue;
		if (msg.role === "user") {
			inv.prompts += 1;
		} else if (msg.role === "assistant") {
			for (const call of (Array.isArray(msg.content) ? msg.content : []) as {
				type?: string;
				id?: string;
				name?: string;
				arguments?: Record<string, unknown>;
			}[]) {
				if (call.type !== "toolCall" || !call.name) continue;
				inv.toolCalls += 1;
				const a = call.arguments ?? {};
				const tool = call.name.toLowerCase();
				const path = arg(a, "path") || arg(a, "file_path");
				if (["read", "grep", "find", "ls"].includes(tool) && path) push(inv.files.read, base(path));
				else if (["write", "edit"].includes(tool) && path) push(inv.files.written, base(path));
				else if (tool === "bash" || tool === "powershell") {
					const shown = arg(a, "description") || arg(a, "command").slice(0, 60);
					push(inv.commands, shown);
				} else if (tool === "webfetch" || tool === "websearch") {
					const url = arg(a, "url");
					if (url) {
						try {
							push(inv.web, new URL(url).host);
						} catch {
							// not a URL: skip
						}
					}
				} else if (tool === "agent" || tool === "subagentworkflow") {
					push(inv.subagents, arg(a, "description") || arg(a, "prompt").slice(0, 60));
				} else if (tool === "skill") {
					push(inv.skills, arg(a, "skill"));
				}
			}
		} else if (msg.role === "toolResult") {
			if (msg.isError) inv.errors += 1;
			if (msg.toolName?.toLowerCase() === "plan") {
				const plan = readPlan(msg.details);
				if (plan) inv.plan = plan;
			}
		}
	}
	return inv;
}
