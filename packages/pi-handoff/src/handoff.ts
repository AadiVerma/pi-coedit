/**
 * The handoff prompt: a plain-markdown digest of the chat, built from the session
 * branch, so a fresh session can pick up where this one left off.
 */

export interface BranchEntry {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		text?: string;
		toolName?: string;
		toolCallId?: string;
		details?: unknown;
		isError?: boolean;
		timestamp?: number;
	};
}

export interface UsageInfo {
	percent: number | null;
	tokens: number | null;
}

const cut = (t: string, n: number) => {
	const line = t.replace(/\s+/g, " ").trim();
	return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (c && typeof c === "object" && (c as any).type === "text" ? String((c as any).text) : ""))
			.join(" ");
	}
	return "";
};

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

const arg = (a: unknown, key: string): string => {
	const v = (a as Record<string, unknown> | undefined)?.[key];
	return typeof v === "string" ? v : "";
};

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k tokens` : `${n} tokens`);

export interface Handoff {
	title: string;
	markdown: string;
}

/** The digest of what the chat did, in the order the Claude mod used. */
export function buildHandoff(input: { entries: BranchEntry[]; usage?: UsageInfo; model?: string }): Handoff {
	const { entries, usage, model } = input;
	const prompts: string[] = [];
	let promptTurns = 0;
	const files: string[] = [];
	const commands: string[] = [];
	const hosts: string[] = [];
	const agents: string[] = [];
	let outcome = "";

	for (const entry of entries) {
		const msg = entry.message;
		if (!msg) continue;
		if (msg.role === "user") {
			promptTurns += 1; // an image-only turn is still a prompt
			const text = cut(textOf(msg.content), 160);
			if (text) prompts.push(text);
		} else if (msg.role === "assistant") {
			for (const call of (Array.isArray(msg.content) ? msg.content : []) as {
				type?: string;
				name?: string;
				arguments?: Record<string, unknown>;
			}[]) {
				if (call.type !== "toolCall" || !call.name) continue;
				const a = call.arguments ?? {};
				const tool = call.name.toLowerCase();
				const path = arg(a, "path") || arg(a, "file_path");
				if (path && ["read", "write", "edit"].includes(tool)) {
					const name = base(path);
					if (!files.includes(name)) files.push(name);
				} else if (tool === "bash" || tool === "powershell") {
					// The raw command is what the next chat would rerun; the description rides along.
					const raw = cut(arg(a, "command"), 60);
					const shown = raw ? (arg(a, "description") ? `${raw} (${cut(arg(a, "description"), 40)})` : raw) : cut(arg(a, "description"), 60);
					if (shown && !commands.includes(shown)) commands.push(shown);
				} else if (tool === "webfetch" || tool === "websearch") {
					const url = arg(a, "url");
					const host = url
						? (() => {
								try {
									return new URL(url).host;
								} catch {
									return "";
								}
							})()
						: "";
					if (host && !hosts.includes(host)) hosts.push(host);
				} else if (tool === "agent" || tool === "subagentworkflow") {
					const who = cut(arg(a, "description") || arg(a, "prompt"), 60);
					if (who && !agents.includes(who)) agents.push(who);
				}
			}
			const text = textOf(msg.content) || msg.text || "";
			if (text.trim()) outcome = text;
		}
	}

	const status: string[] = [`- Turns with prompts: ${promptTurns}`];
	if (model) status.push(`- Model: ${model}`);
	if (usage?.percent !== null && usage?.percent !== undefined) status.push(`- Context used: ${Math.round(usage.percent)}%`);
	if (usage?.tokens !== null && usage?.tokens !== undefined) status.push(`- Context: ${kTokens(usage.tokens)}`);
	if (files.length) status.push(`- Files touched: ${files.slice(0, 10).join(", ")}`);
	if (commands.length) status.push(`- Commands run: ${commands.slice(0, 8).join("; ")}`);
	if (hosts.length) status.push(`- Web sources: ${hosts.slice(0, 6).join(", ")}`);
	if (agents.length) status.push(`- Subagents: ${agents.slice(0, 6).join("; ")}`);

	const digest = prompts.length ? prompts.map((p, i) => `${i + 1}. ${p}`).join("\n") : "(no prompts)";
	const lastPrompt = prompts.length ? prompts[prompts.length - 1] : "";
	const goal = prompts.length ? prompts[0] : "(the chat had no prompt)";

	const markdown = [
		"# Handoff",
		"",
		`## Goal`,
		"",
		goal,
		"",
		`## Where this stands`,
		"",
		...status,
		`- Last agent message: "${cut(outcome, 400)}"`,
		"",
		`## What the previous chat did`,
		"",
		digest,
		"",
		`## Next steps`,
		"",
		lastPrompt ? `Pick up the last request: "${lastPrompt}"` : "Ask the user what to work on.",
		"",
	].join("\n");

	return { title: "Handoff", markdown };
}
