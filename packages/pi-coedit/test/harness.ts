/**
 * Scenario harness: drives the REAL plugin factory with a mock ExtensionAPI and
 * ExtensionContext against a real temp git repo + real coedit store. No fs-watch
 * timing dependencies except where a scenario explicitly waits.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/index.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "coedit-scen-"));
	git(dir, ["init", "-b", "main"]);
	git(dir, ["config", "user.name", "Test Human"]);
	git(dir, ["config", "user.email", "human@example.com"]);
	return dir;
}

export function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function wf(repo: string, rel: string, content: string): void {
	writeFileSync(join(repo, rel), content);
}

/**
 * Events carry the worktree as git resolves it (realpath). macOS /var/folders is
 * a symlink to /private/var/folders, so consumers MUST filter by the resolved
 * path — this helper is the single source of truth for that.
 */
export function realRepo(repo: string): string {
	return require_realpath()(repo);
}

function require_realpath(): (p: string) => string {
	const fs = require_fs();
	return fs.realpathSync;
}

function require_fs(): typeof import("node:fs") {
	return fsModule;
}
import * as fsModule from "node:fs";

export interface Harness {
	repo: string;
	handlers: Map<string, (event: never, ctx: never) => unknown>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
	tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }>;
	sent: Array<{ customType: string; content: string }>;
	notifies: Array<{ message: string; type?: string }>;
	widget: { content: string[] | undefined };
	ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		select: (choice: string) => Promise<string | undefined>;
	};
	setPolicy(policy: string): Promise<void>;
	dispatch(event: string, payload?: Record<string, unknown>): Promise<unknown>;
	startSession(): Promise<void>;
	shutdownSession(): Promise<void>;
	ctx: ExtensionContext;
}

export async function createHarness(repo: string, opts?: { mode?: "json" | "tui"; hasUI?: boolean }): Promise<Harness> {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const commands = new Map();
	const tools: Harness["tools"] = [];
	const sent: Harness["sent"] = [];
	const notifies: Harness["notifies"] = [];
	const widget: Harness["widget"] = { content: undefined };
	let selectResponse: string | undefined;
	const confirmQueue: boolean[] = [];

	const fakePi = {
		on: (name: string, handler: never) => {
			handlers.set(name, handler as never);
			return () => undefined;
		},
		registerCommand: (name: string, def: never) => commands.set(name, def),
		registerTool: (def: never) => tools.push(def as never),
		registerProvider: () => undefined,
		sendMessage: (message: { customType: string; content: string }) => sent.push(message),
		sendUserMessage: () => undefined,
		appendEntry: () => undefined,
	} as never;

	const fakeCtx = {
		cwd: repo,
		mode: opts?.mode ?? "json",
		hasUI: opts?.hasUI ?? false,
		ui: {
			notify: (message: string, type?: string) => notifies.push({ message, type }),
			confirm: async (_title: string, _message: string) => confirmQueue.shift() ?? false,
			select: async (_title: string, _options: string[]) => selectResponse,
			setWidget: (_key: string, content: string[] | undefined) => {
				widget.content = content;
			},
		},
		sessionManager: {
			getSessionId: () => "sess-scenario-1",
			getSessionFile: () => "/tmp/session.jsonl",
		},
		model: { id: "test-model" },
	} as unknown as ExtensionContext;

	(plugin as unknown as (pi: unknown) => void)(fakePi);

	const harness: Harness = {
		repo,
		handlers: handlers as unknown as Map<string, (event: never, ctx: never) => unknown>,
		commands: commands as never,
		tools,
		sent,
		notifies,
		widget,
		ui: {
			confirm: async () => (confirmQueue.push(true), true),
			select: async (choice: string) => {
				selectResponse = choice;
				return choice;
			},
		},
		async setPolicy(policy: string) {
			const { Store } = await import("@coedit/core");
			const store = await Store.open(repo, join(repo, ".git"));
			await store.updateConfig({ overwriteGuard: policy as never });
			store.close();
		},
		async dispatch(event: string, payload: Record<string, unknown> = {}) {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`no handler for ${event}`);
			return (handler as unknown as (e: unknown, c: unknown) => unknown)({ type: event, ...payload }, fakeCtx);
		},
		async startSession() {
			await (handlers.get("session_start") as unknown as (e: unknown, c: unknown) => Promise<void>)?.({ type: "session_start", reason: "startup" }, fakeCtx);
		},
		async shutdownSession() {
			await (handlers.get("session_shutdown") as unknown as (e: unknown, c: unknown) => Promise<void>)?.({ type: "session_shutdown", reason: "quit" }, fakeCtx);
		},
		ctx: fakeCtx,
	};
	// expose confirm/select queues for scripted answers
	(harness as unknown as { confirmQueue: boolean[]; setSelect: (s: string) => void }).confirmQueue = confirmQueue;
	(harness as unknown as { setSelect: (s: string) => void }).setSelect = (s: string) => {
		selectResponse = s;
	};
	return harness;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
