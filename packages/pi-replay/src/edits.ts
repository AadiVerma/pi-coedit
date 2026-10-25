/**
 * The chat's file edits, collected from the session branch: each edit tool result
 * carries a display diff in its details, and the file path comes from the matching
 * tool call in the assistant message (matched by tool call id).
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
		timestamp?: number;
	};
}

export interface EditStep {
	path: string;
	diff: string;
	at: number;
}

const pathFromDiff = (diff: string): string => {
	// Unified headers read "--- a/src/auth.ts"; the +++ side is the new file.
	const hit = /^\+\+\+ \+?b?\/?(.+)$/m.exec(diff);
	return hit ? hit[1].trim() : "";
};

export function collectEdits(entries: BranchEntry[]): EditStep[] {
	const argsByCall = new Map<string, Record<string, unknown>>();
	const edits: EditStep[] = [];

	for (const entry of entries) {
		const msg = entry.message;
		if (!msg) continue;
		if (msg.role === "assistant") {
			for (const call of (Array.isArray(msg.content) ? msg.content : []) as {
				type?: string;
				id?: string;
				name?: string;
				arguments?: Record<string, unknown>;
			}[]) {
				if (call.type === "toolCall" && call.id && call.name) argsByCall.set(call.id, call.arguments ?? {});
			}
		} else if (msg.role === "toolResult") {
			const tool = msg.toolName?.toLowerCase();
			if (tool !== "edit" && tool !== "write") continue;
			if (msg.isError) continue;
			const details = msg.details as { diff?: unknown } | undefined;
			if (!details || typeof details.diff !== "string" || !details.diff.trim()) continue;
			// pi's display diff carries no file header, so the call's path arg is the
			// source; the diff header is the fallback for results without a match.
			const args = argsByCall.get(msg.toolCallId ?? "");
			const pathArg = (args?.path ?? args?.file_path) as string | undefined;
			const path = pathArg
				? pathArg.split("/").filter(Boolean).pop()!
				: pathFromDiff(details.diff);
			if (!path) continue;
			edits.push({ path, diff: details.diff, at: msg.timestamp ?? 0 });
		}
	}
	return edits;
}
