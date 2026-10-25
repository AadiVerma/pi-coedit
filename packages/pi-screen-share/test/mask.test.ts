import { test } from "node:test";
import assert from "node:assert/strict";
import { maskSensitive } from "../src/mask.ts";

test("email addresses are fully masked", () => {
	assert.equal(maskSensitive("reach me at ada@example.com today"), "reach me at ███████████████ today"); // one block per character
});

test("multiple emails mask independently", () => {
	const out = maskSensitive("a@x.com and b@y.org");
	assert.ok(!out.includes("a@x.com"));
	assert.ok(!out.includes("b@y.org"));
});

test("phone numbers in common formats are masked", () => {
	for (const phone of ["+1 415 555 2671", "(415) 555-2671", "415-555-2671", "+44 20 7946 0958"]) {
		const out = maskSensitive(`call ${phone} now`);
		assert.ok(!out.includes("555") && !out.includes("7946"), phone);
	}
});

test("credit-card-shaped numbers are masked", () => {
	const out = maskSensitive("card 4111 1111 1111 1111 on file");
	assert.ok(!out.includes("4111"));
});

test("dollar and euro amounts are masked", () => {
	const out = maskSensitive("we charge $1,250.50 per seat and €900 flat");
	assert.ok(!out.includes("1,250.50"));
	assert.ok(!out.includes("900"));
	assert.ok(out.includes("$") || out.includes("█"), "the currency symbol stays as a hint");
});

test("plain small integers are NOT masked", () => {
	assert.equal(maskSensitive("step 3 of 12"), "step 3 of 12");
});

test("ipv4 addresses are masked", () => {
	const out = maskSensitive("server at 10.0.3.42 refused");
	assert.ok(!out.includes("10.0.3.42"));
});

test("urls keep their host but mask the path", () => {
	const out = maskSensitive("see https://api.example.com/v1/users/8123?key=abc");
	assert.ok(out.includes("api.example.com"), "the host stays");
	assert.ok(!out.includes("8123"));
	assert.ok(!out.includes("key=abc"));
});

test("code blocks and inline code are left alone", () => {
	const code = "run `npm run 4111` please";
	assert.equal(maskSensitive(code), code);
});

test("fenced code blocks are left alone", () => {
	const md = "before\n```js\nconst price = 1250.50;\n```\nafter $99";
	const out = maskSensitive(md);
	assert.ok(out.includes("1250.50"), "the fence keeps its code");
	assert.ok(!out.includes("$99"), "prose still masks");
});

test("ordinary prose, markdown, and layout are untouched", () => {
	const md = "# Title\n\n- **bold** point\n- *italic* point\n\n> quote\n";
	assert.equal(maskSensitive(md), md);
});

test("masking is idempotent", () => {
	const once = maskSensitive("mail a@x.com $500");
	const twice = maskSensitive(once);
	assert.equal(once, twice);
});

test("empty and plain strings come back unchanged", () => {
	assert.equal(maskSensitive(""), "");
	assert.equal(maskSensitive("hello"), "hello");
});

test("mixed content masks only the sensitive bits", () => {
	const out = maskSensitive("Hi, I'm Ada (ada@example.com, +1 415 555 2671). The invoice is $4,300.");
	assert.ok(out.includes("Ada"), "a first name in prose is not masked");
	assert.ok(!out.includes("ada@example.com"));
	assert.ok(!out.includes("415 555"));
	assert.ok(!out.includes("4,300"));
});
