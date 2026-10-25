/**
 * One tool call, described: its kind (with the Claude mod's step colors) and a short
 * plain-words label for the /helpers feed.
 */

export const KINDS = ["Command", "Connector", "File read", "File write", "Skill", "Subagent", "Tool", "Web"] as const;

export type StepKind = (typeof KINDS)[number];

/** The Claude mod's step colors: easy to tell apart on light and dark terminals. */
export const KIND_COLOR: Record<StepKind, string> = {
	Command: "#ca8a04",
	Connector: "#2563eb",
	"File read": "#16a34a",
	"File write": "#d97757",
	Skill: "#9333ea",
	Web: "#0891b2",
	Subagent: "#db2777",
	Tool: "#78716c",
};

export interface Described {
	kind: StepKind;
	label: string;
}

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

const str = (input: Record<string, unknown> | undefined, key: string) => {
	const v = input?.[key];
	return typeof v === "string" ? oneLine(v) : "";
};

const pathArg = (input: Record<string, unknown> | undefined) => {
	const p = str(input, "path") || str(input, "file_path") || str(input, "notebook_path");
	return { path: p, name: p ? base(p) : "" };
};

const file = (input: Record<string, unknown> | undefined, verb: string, kind: StepKind): Described => {
	const { name } = pathArg(input);
	return { kind, label: name ? `${verb} ${name}` : `${verb} a file` };
};

/** A short plain-words label for a tool call, for the /helpers feed. */
export function describe(tool: string, input?: Record<string, unknown>): Described {
	// Pi registers tools under their real names (Agent, Read, Bash): match any casing.
	const key = tool.toLowerCase();
	// MCP-style names keep the Connector color, with the server dropped from the label.
	if (key.startsWith("mcp__") || key.startsWith("mcp_")) {
		const name = tool.replace(/^mcp__|^mcp_/, "").split("__").pop() ?? tool;
		const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase();
		return { kind: "Connector", label: `Connector · ${words}` };
	}
	switch (key) {
		case "skill":
			return { kind: "Skill", label: "Using a skill" };
		case "read":
			return file(input, "Reading", "File read");
		case "write":
			return file(input, "Writing", "File write");
		case "edit":
			return file(input, "Editing", "File write");
		case "ls":
			return { kind: "File read", label: "Listing a folder" };
		case "grep":
		case "find": {
			const pat = str(input, "pattern");
			return {
				kind: "File read",
				label: pat ? `Searching files for "${pat.slice(0, 40)}"` : "Searching files",
			};
		}
		case "bash":
		case "powershell": {
			const shown = str(input, "description");
			if (shown) return { kind: "Command", label: shown };
			const command = str(input, "command").slice(0, 80);
			return { kind: "Command", label: command ? `Running: ${command}` : "Running a command" };
		}
		case "websearch": {
			const q = str(input, "query");
			return { kind: "Web", label: q ? `Searching the web: ${q}` : "Searching the web" };
		}
		case "webfetch":
			return { kind: "Web", label: "Opening a web page" };
		// The names @tintinweb/pi-subagents registers, if it is installed.
		case "agent":
		case "subagentworkflow": {
			const d = str(input, "description") || str(input, "prompt").slice(0, 60);
			return { kind: "Subagent", label: d ? `Subagent: ${d}` : "Starting a subagent" };
		}
		case "get_subagent_result":
		case "steer_subagent":
			return { kind: "Subagent", label: "Collecting a subagent's result" };
		default:
			return { kind: "Tool", label: `Using ${tool}` };
	}
}
