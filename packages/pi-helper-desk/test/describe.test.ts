import { test } from "node:test";
import assert from "node:assert/strict";
import { KIND_COLOR, KINDS, describe } from "../src/describe.ts";

const kindOf = (tool: string, input: Record<string, unknown> = {}) => describe(tool, input).kind;
const labelOf = (tool: string, input: Record<string, unknown> = {}) => describe(tool, input).label;

test("every kind has a color, and the set matches the Claude mod's palette", () => {
	assert.deepEqual([...KINDS].sort(), [
		"Command",
		"Connector",
		"File read",
		"File write",
		"Skill",
		"Subagent",
		"Tool",
		"Web",
	]);
	assert.equal(KIND_COLOR.Command, "#ca8a04");
	assert.equal(KIND_COLOR.Connector, "#2563eb");
	assert.equal(KIND_COLOR["File read"], "#16a34a");
	assert.equal(KIND_COLOR["File write"], "#d97757");
	assert.equal(KIND_COLOR.Skill, "#9333ea");
	assert.equal(KIND_COLOR.Web, "#0891b2");
	assert.equal(KIND_COLOR.Subagent, "#db2777");
	assert.equal(KIND_COLOR.Tool, "#78716c");
});

// ---- File reads ----

test("read names the file it opens", () => {
	assert.equal(labelOf("read", { path: "/a/b/research.md" }), "Reading research.md");
	assert.equal(kindOf("read"), "File read");
});

test("read without a path still says it is reading", () => {
	assert.equal(labelOf("read", {}), "Reading a file");
	assert.equal(labelOf("read"), "Reading a file");
});

test("file_path is honored as an alias for path", () => {
	assert.equal(labelOf("read", { file_path: "/x/y/notes.txt" }), "Reading notes.txt");
});

test("grep and find report the pattern they search for", () => {
	assert.equal(labelOf("grep", { pattern: "TODO" }), 'Searching files for "TODO"');
	assert.equal(labelOf("find", { pattern: "fix.?me" }), 'Searching files for "fix.?me"');
	assert.equal(kindOf("grep"), "File read");
	assert.equal(kindOf("find"), "File read");
});

test("grep without a pattern falls back to searching", () => {
	assert.equal(labelOf("grep", {}), "Searching files");
});

test("long patterns are cut to 40 characters with an ellipsis", () => {
	const pat = "x".repeat(60);
	assert.equal(labelOf("grep", { pattern: pat }), `Searching files for "${"x".repeat(40)}"`);
});

test("ls reads a folder", () => {
	assert.equal(kindOf("ls"), "File read");
	assert.equal(labelOf("ls", { path: "/tmp" }), "Listing a folder");
});

// ---- File writes ----

test("write and edit name the file they change", () => {
	assert.equal(labelOf("write", { path: "/a/b/out.md" }), "Writing out.md");
	assert.equal(labelOf("edit", { path: "/a/b/out.md" }), "Editing out.md");
	assert.equal(kindOf("write"), "File write");
	assert.equal(kindOf("edit"), "File write");
});

test("notebook edits are file writes too", () => {
	assert.equal(kindOf("edit", { notebook_path: "/n/b.ipynb" }), "File write");
	assert.equal(labelOf("edit", { notebook_path: "/n/b.ipynb" }), "Editing b.ipynb");
});

// ---- Commands ----

test("bash prefers its description", () => {
	assert.equal(labelOf("bash", { command: "ls -la /tmp", description: "List the temp folder" }), "List the temp folder");
	assert.equal(kindOf("bash"), "Command");
});

test("bash without a description shows the command, cut to 80", () => {
	assert.equal(labelOf("bash", { command: "echo hi" }), "Running: echo hi");
	const long = "y".repeat(120);
	assert.equal(labelOf("bash", { command: long }), `Running: ${"y".repeat(80)}`);
});

test("bash with neither description nor command still reads as running", () => {
	assert.equal(labelOf("bash", {}), "Running a command");
});

test("powershell is a command too", () => {
	assert.equal(kindOf("powershell", { command: "dir" }), "Command");
	assert.equal(labelOf("powershell", { command: "dir" }), "Running: dir");
});

// ---- Web ----

test("web search and fetch are Web steps", () => {
	assert.equal(kindOf("websearch", { query: "pi coding agent" }), "Web");
	assert.equal(labelOf("websearch", { query: "pi coding agent" }), "Searching the web: pi coding agent");
	assert.equal(kindOf("webfetch", { url: "https://docs.example.com/x" }), "Web");
});

// ---- Subagents ----

test("Agent launches are Subagent steps named by their description", () => {
	assert.equal(kindOf("agent", { description: "Read the research notes", prompt: "go" }), "Subagent");
	assert.equal(labelOf("agent", { description: "Read the research notes", prompt: "go" }), "Subagent: Read the research notes");
});

test("Agent without a description falls back to a cut prompt", () => {
	assert.equal(labelOf("agent", { prompt: "p".repeat(80) }), `Subagent: ${"p".repeat(60)}`);
	assert.equal(labelOf("agent", {}), "Starting a subagent");
});

test("SubagentWorkflow is a subagent step", () => {
	assert.equal(kindOf("subagentworkflow", { description: "Parallel research" }), "Subagent");
	assert.equal(labelOf("subagentworkflow", { description: "Parallel research" }), "Subagent: Parallel research");
});

test("collecting a subagent's result is its own step", () => {
	assert.equal(kindOf("get_subagent_result", { id: "a1" }), "Subagent");
	assert.equal(labelOf("get_subagent_result", { id: "a1" }), "Collecting a subagent's result");
});

test("steering a subagent reads as a subagent step with a plain label", () => {
	assert.equal(kindOf("steer_subagent", { id: "a1" }), "Subagent");
});

// ---- Tools and the unknown ----

test("the plan tool is an ordinary Tool step", () => {
	assert.equal(kindOf("plan", { steps: [] }), "Tool");
	assert.equal(labelOf("plan", { steps: [] }), "Using plan");
});

test("unknown tools keep their name and stay Tool steps", () => {
	assert.equal(kindOf("some_mcp_thing"), "Tool");
	assert.equal(labelOf("some_mcp_thing"), "Using some_mcp_thing");
});

test("mcp-style tool names are Connector steps with a tidied label, never a raw id", () => {
	assert.equal(kindOf("mcp__notion__search"), "Connector");
	assert.equal(labelOf("mcp__notion__search"), "Connector · search");
	assert.equal(kindOf("mcp_notion_search"), "Connector");
	// No double underscore: there is no server/tool split, so the whole name is tidied.
	assert.equal(labelOf("mcp_notion_search"), "Connector · notion search");
});

// ---- Casing: pi registers tools with their real names (Agent, Read, Bash) ----

test("tool names are matched case-insensitively", () => {
	assert.equal(kindOf("Agent", { description: "Research notes" }), "Subagent");
	assert.equal(labelOf("Agent", { description: "Research notes" }), "Subagent: Research notes");
	assert.equal(kindOf("Read", { path: "/a/b.md" }), "File read");
	assert.equal(labelOf("Read", { path: "/a/b.md" }), "Reading b.md");
	assert.equal(kindOf("Bash", { command: "ls" }), "Command");
	assert.equal(kindOf("EDIT", { path: "/a/b.md" }), "File write");
	assert.equal(labelOf("Get_Subagent_Result"), "Collecting a subagent's result");
});

// ---- Robustness ----

test("non-string argument values are ignored, not stringified", () => {
	assert.equal(labelOf("read", { path: 42 }), "Reading a file");
	assert.equal(labelOf("bash", { command: { a: 1 } }), "Running a command");
	assert.equal(labelOf("grep", { pattern: null }), "Searching files");
});

test("whitespace inside labels collapses to single spaces", () => {
	assert.equal(labelOf("bash", { description: "List\nthe\ttemp   folder" }), "List the temp folder");
});

test("undefined and missing input behave like an empty object", () => {
	assert.equal(labelOf("read", undefined as unknown as Record<string, unknown>), "Reading a file");
	assert.equal(kindOf("bash", undefined as unknown as Record<string, unknown>), "Command");
});

test("empty-string paths fall back to the plain label", () => {
	assert.equal(labelOf("read", { path: "" }), "Reading a file");
});

test("a path with a trailing slash still names its folder basename", () => {
	assert.equal(labelOf("read", { path: "/a/b/" }), "Reading b");
});

test("a bare filename with no folder is used as-is", () => {
	assert.equal(labelOf("write", { path: "out.md" }), "Writing out.md");
});
