import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createScreenShare } from "../src/index.ts";

class FakePi {
	commands: { name: string; def: any }[] = [];
	transformer: ((md: string, context: any) => string) | undefined = undefined;
	registerCommand(name: string, def: any) {
		this.commands.push({ name, def });
	}
	registerMarkdownTransformer(t: (md: string, context: any) => string) {
		this.transformer = t;
	}
}

const boot = () => {
	const pi = new FakePi();
	createScreenShare(pi as unknown as ExtensionAPI);
	return pi;
};

test("the extension registers /screen-share and a markdown transformer", () => {
	const pi = boot();
	assert.deepEqual(pi.commands.map((c) => c.name), ["screen-share"]);
	assert.ok(pi.transformer);
});

test("masking starts off: text flows untouched", () => {
	const pi = boot();
	assert.equal(pi.transformer!("mail a@x.com", { messageType: "assistant" }), "mail a@x.com");
});

test("after the toggle, assistant output masks", async () => {
	const pi = boot();
	await pi.commands[0].def.handler("", { ui: { notify() {} } });
	assert.equal(pi.transformer!("mail a@x.com", { messageType: "assistant" })!.includes("a@x.com"), false);
});

test("the user's own message is never masked (they typed it)", () => {
	const pi = boot();
	pi.commands[0].def.handler("", { ui: { notify() {} } });
	assert.equal(pi.transformer!("mail a@x.com", { messageType: "user" }), "mail a@x.com");
});

test("a second toggle turns masking off again", () => {
	const pi = boot();
	const ctx = { ui: { notify() {} } };
	pi.commands[0].def.handler("", ctx);
	pi.commands[0].def.handler("", ctx);
	assert.equal(pi.transformer!("mail a@x.com", { messageType: "assistant" }), "mail a@x.com");
});
