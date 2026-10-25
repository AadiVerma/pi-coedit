import { test } from "node:test";
import assert from "node:assert/strict";

test("package loads", async () => {
	const mod = await import("../src/index.ts");
	assert.equal(typeof mod.default, "function");
});
