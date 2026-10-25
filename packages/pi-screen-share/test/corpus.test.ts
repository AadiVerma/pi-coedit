import { test } from "node:test";
import assert from "node:assert/strict";
import { maskSensitive } from "../src/mask.ts";

// ---------------------------------------------------------------------------
// The sensitive corpus: every shape a recording must not show.
// ---------------------------------------------------------------------------

const SENSITIVE: [name: string, text: string, mustHide: string][] = [
	// Emails — plain, plus-tagged, dotted, numeric, subdomain-tld shapes.
	["plain email", "mail ada@example.com now", "ada@example.com"],
	["plus tag", "x ada+lists@example.com y", "ada+lists@example.com"],
	["dotted local", "x first.last@corp.io y", "first.last@corp.io"],
	["percent escape", "x a%b@c.dev y", "a%b@c.dev"],
	["numeric local", "x 12345@numbers.net y", "12345@numbers.net"],
	["long tld", "x a@b.technology y", "a@b.technology"],
	["two-part tld", "x a@b.co.uk y", "a@b.co.uk"],
	["underscore local", "x snake_case@mail.com y", "snake_case@mail.com"],
	["dash domain", "x a@my-site.org y", "a@my-site.org"],
	["email twice", "a@x.com then b@y.com", "a@x.com"],
	// Phones — international and US shapes.
	["intl spaced", "call +1 415 555 2671 now", "555 2671"],
	["intl dense", "call +14155552671 now", "14155552671"],
	["intl long", "call +44 20 7946 0958 now", "7946 0958"],
	["paren area", "call (415) 555-2671 now", "555-2671"],
	["dashed us", "call 415-555-2671 now", "415-555-2671"],
	["spaced us", "call 415 555 2671 now", "415 555 2671"],
	["no-sep us", "call 4155552671 now", "4155552671"],
	["dotted us", "call 415.555.2671 now", "415.555.2671"],
	// Cards.
	["visa spaced", "card 4111 1111 1111 1111 ok", "4111 1111"],
	["visa dense", "card 4111111111111111 ok", "4111111111111111"],
	["mc dashed", "card 5500-0000-0000-0004 ok", "5500-0000"],
	["amex", "card 3782 822463 10005 ok", "3782 822463"],
	["mixed seps", "card 4111 1111-1111 1111 ok", "4111 1111"],
	// IPs.
	["ipv4 plain", "host 10.0.3.42 down", "10.0.3.42"],
	["ipv4 public", "host 8.8.8.8 down", "8.8.8.8"],
	["ipv4 high", "host 192.168.255.1 down", "192.168.255.1"],
	// Money.
	["dollars", "costs $1,250.50 flat", "1,250.50"],
	["dollars int", "costs $500 flat", "$500"],
	["euros", "costs €900 flat", "900"],
	["pounds", "costs £42.99 flat", "42.99"],
	["usd suffix", "costs 1,250.50 USD flat", "1,250.50"],
	["eur suffix", "costs 900 EUR flat", "900 EUR"],
	["gbp suffix", "costs 75 GBP flat", "75 GBP"],
	["zero", "costs $0 flat", "0"],
	["big money", "costs $1,250,000.00 flat", "1,250,000.00"],
	// URLs — query and path carry the secrets.
	["url query key", "see https://api.example.com/v1?key=abc123", "abc123"],
	["url user id", "see https://app.example.com/users/8123/settings", "8123"],
	["url token", "see https://x.com/t/eyJhbGciOi", "eyJhbGciOi"],
];

for (const [name, text, mustHide] of SENSITIVE) {
	test(`masks: ${name}`, () => {
		const out = maskSensitive(text);
		assert.ok(!out.includes(mustHide), `${name}: leaked "${mustHide}" → ${out}`);
		assert.ok(out.includes("█"), `${name}: something was drawn as blocks`);
	});
}

// ---------------------------------------------------------------------------
// The benign corpus: things that must NEVER be masked (false positives would
// make recordings useless and lie about safety).
// ---------------------------------------------------------------------------

const BENIGN: [name: string, text: string][] = [
	["semver", "bump to 1.4.3"],
	["semver range", "install ^1.4.3 or ~2.0.0"],
	["version triple", "node v22.11.0 is fine"],
	["loose version pair", "port 3000 and 8080"],
	["time", "meet at 10:30"],
	["date iso", "due 2026-10-25"],
	["date slash", "due 10/25/2026"],
	["issue ref", "fixes #1234"],
	["hex color", "paint it #ffffff"],
	["css hex", "background: #1c1917;"],
	["markdown bold", "this is **important**"],
	["markdown italic", "this is *fine*"],
	["heading level", "## Section"],
	["small numbers", "step 3 of 12"],
	["percent", "about 50% done"],
	["ratio", "a 16:9 video"],
	["generic path", "edit /src/lib/util.ts"],
	["url path word", "GET /v1/users is fine"],
	["filename dots", "open config.json"],
	["range", "lines 10-25"],
	["negative number", "offset -5"],
	["coordinates", "at 37.7749, -122.4194"],
	["generic slash", "src/test"],
	["uuid-ish word", "the id is abc123"],
	["arrow", "a -> b"],
	["ts generic", "use Foo<Bar>"],
	["matrix row", "[1, 2, 3]"],
	["phone-like small", "call 555 after 6"],
	["plain sentence", "the quick brown fox"],
	["code ticks inline", "run `npm install` first"],
	["fenced code", "before\n```\nconst price = 1250.50;\nconst email = a@b.com;\n```\nafter"],
	["fenced js block", "```js\nconst ip = '10.0.3.42';\n```"],
];

for (const [name, text] of BENIGN) {
	test(`keeps: ${name}`, () => {
		assert.equal(maskSensitive(text), text);
	});
}

// ---------------------------------------------------------------------------
// Combination and structural cases.
// ---------------------------------------------------------------------------

test("sensitive inside markdown emphasis is still masked", () => {
	const out = maskSensitive("costs **$500** today");
	assert.ok(!out.includes("$500"));
});

test("sensitive inside a list item is still masked", () => {
	const out = maskSensitive("- invoice: $4,300\n- contact: a@b.com");
	assert.ok(!out.includes("4,300"));
	assert.ok(!out.includes("a@b.com"));
});

test("sensitive inside a blockquote is still masked", () => {
	const out = maskSensitive("> email me at a@b.com");
	assert.ok(!out.includes("a@b.com"));
});

test("sensitive in a table cell is still masked", () => {
	const out = maskSensitive("| host | ip |\n| a | 10.0.3.42 |");
	assert.ok(!out.includes("10.0.3.42"));
});

test("code fence protects only its own lines", () => {
	const md = "price $99\n```\n$99\n```\nalso $99";
	const out = maskSensitive(md);
	assert.equal((out.match(/\$99/g) ?? []).length, 1, "exactly the fenced literal survives");
	assert.ok(!out.startsWith("price $99"), "prose before the fence masks");
	assert.ok(!out.endsWith("also $99"), "prose after the fence masks");
});

test("unclosed code fence protects to the end", () => {
	const out = maskSensitive("free $5\n```\nstill $5");
	assert.ok(out.includes("still $5"), "the unterminated fence holds");
	assert.ok(!out.includes("free $5"), "prose before masks");
});

test("two inline code spans, prose between them masks", () => {
	const out = maskSensitive("`a@x.com` mid b@y.com `c@z.com`");
	assert.ok(out.includes("a@x.com"), "first span kept");
	assert.ok(out.includes("c@z.com"), "second span kept");
	assert.ok(!out.includes("b@y.com"), "prose between masks");
});

test("an URL with no path is kept whole except nothing new", () => {
	const out = maskSensitive("see https://example.com today");
	assert.equal(out.includes("example.com"), true);
	assert.ok(!out.includes("█"), "nothing to hide: no blocks");
});

test("an URL with only a slash path masks minimally", () => {
	const out = maskSensitive("see https://example.com/ today");
	assert.ok(out.includes("example.com"));
});

test("mailto-shaped text is masked as an email", () => {
	const out = maskSensitive("mailto:ada@example.com");
	assert.ok(!out.includes("ada@example.com"));
});

test("repeated sensitive values mask the same way each time", () => {
	const text = "a@x.com ... a@x.com ... a@x.com";
	const out = maskSensitive(text);
	assert.ok(!out.includes("a@x.com"));
	assert.equal((out.match(/█+/g) ?? []).length >= 3, true);
});

test("very long sensitive strings mask completely", () => {
	const email = `${"verylongname".repeat(5)}@example.com`;
	const out = maskSensitive(`x ${email} y`);
	assert.ok(!out.includes(email));
});

test("unicode prose is untouched", () => {
	const text = "汉字テスト ✓ π λ → ✓ 😀 mix";
	assert.equal(maskSensitive(text), text);
});

test("an entire message of only code fences changes nothing", () => {
	const md = "```\n$5 a@b.com\n```\n```js\n+44 20 7946 0958\n```";
	assert.equal(maskSensitive(md), md);
});

test("money with space after the symbol masks", () => {
	const out = maskSensitive("costs $ 500 flat");
	assert.ok(!out.includes("500"), "the digits still hide");
});

test("adjacent sensitive values both mask", () => {
	const out = maskSensitive("a@x.com and $500 and 10.0.3.42");
	assert.ok(!out.includes("a@x.com"));
	assert.ok(!out.includes("500"));
	assert.ok(!out.includes("10.0.3.42"));
});

test("a masked run never re-matches on a second pass (idempotent corpus)", () => {
	for (const [name, text] of [...SENSITIVE.map((s) => [s[0], s[1]] as [string, string])]) {
		const once = maskSensitive(text);
		assert.equal(maskSensitive(once), once, name);
	}
});

test("blank lines and layout survive", () => {
	const md = "para one\n\npara two\n\n- a\n- b\n";
	assert.equal(maskSensitive(md), md);
});
