/* Unit tests for the merge helpers and the config bridge.
 * Run: node --test tests/bridge.test.js   (Node 22+, no dependencies) */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-bridge-test-"));
process.env.BRIDGE_ENV_FILE = path.join(tmp, "missing.env");
process.env.BRIDGE_TOKEN = "test-token-0123456789-abcdefgh";
process.env.BRIDGE_STATE_DIR = path.join(tmp, "state");
process.env.MM_DIR = path.join(tmp, "MagicMirror"); // no merge file here, falls back to repo copy

const merge = require("../config/mm-bridge-merge");
const envfile = require("../config-bridge/lib/envfile");
const { validate } = require("../config-bridge/lib/validate");
const net = require("../config-bridge/lib/net");
const { Store } = require("../config-bridge/lib/store");
const bridge = require("../config-bridge/server");

test("deepMerge: objects merge, arrays replace, proto keys ignored", () => {
	const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2, 3] };
	const out = merge.deepMerge(base, JSON.parse("{\"nested\":{\"y\":5},\"list\":[9],\"__proto__\":{\"polluted\":true}}"));
	assert.deepEqual(out, { a: 1, nested: { x: 1, y: 5 }, list: [9] });
	assert.equal({}.polluted, undefined);
	assert.deepEqual(base.nested, { x: 1, y: 2 }, "base untouched");
});

test("applyBridgeOverrides only touches config of matching modules", () => {
	const config = { modules: [{ module: "A", position: "top_left", config: { keep: 1, list: [1] } }, { module: "B" }] };
	const applied = merge.applyBridgeOverrides(config, { A: { list: [2], position: "evil" }, C: { x: 1 } });
	assert.deepEqual(applied, ["A"]);
	assert.equal(config.modules[0].position, "top_left");
	assert.deepEqual(config.modules[0].config, { keep: 1, list: [2], position: "evil" });
	assert.equal(config.modules[1].config, undefined);
});

test("secret placeholders resolve only in the full pass", () => {
	const overrides = { A: { calendars: [{ url: "**SECRET_BRIDGE_X_1**" }, { url: "**SECRET_MISSING**" }] } };
	const env = { SECRET_BRIDGE_X_1: "https://example.com/a.ics" };
	const full = { modules: [{ module: "A", config: {} }] };
	const redacted = { modules: [{ module: "A", config: {} }] };
	merge.applyBridgeOverrides(full, overrides, { resolve: true, env });
	merge.applyBridgeOverrides(redacted, overrides, { resolve: false, env });
	assert.equal(full.modules[0].config.calendars[0].url, "https://example.com/a.ics");
	assert.equal(full.modules[0].config.calendars[1].url, "**SECRET_MISSING**", "unknown secret stays a placeholder");
	assert.equal(redacted.modules[0].config.calendars[0].url, "**SECRET_BRIDGE_X_1**");
});

test("applyBridgeFile never throws on a broken file", () => {
	const file = path.join(tmp, "broken.json");
	fs.writeFileSync(file, "{not json");
	const original = console.error;
	console.error = () => {};
	try {
		assert.deepEqual(merge.applyBridgeFile({ modules: [] }, file), []);
	} finally {
		console.error = original;
	}
	assert.deepEqual(merge.applyBridgeFile({ modules: [] }, path.join(tmp, "nope.json")), []);
});

test("envfile.quote round trips URLs with # & ? = through util.parseEnv", () => {
	for (const value of ["https://x.test/a.ics?x=1&y=2#frag", "it's here", "plain"]) {
		assert.equal(envfile.parse("K=" + envfile.quote(value)).K, value);
	}
	assert.throws(() => envfile.quote("line\nbreak"));
	assert.throws(() => envfile.quote("both ' and \" quotes"));
});

test("envfile.updateManaged keeps hand written lines and drops stale managed keys", () => {
	const text = "# comment\nSECRET_OWM_KEY=abc\nSECRET_BRIDGE_OLD_1='https://old'\nHOME_LAT=1\n";
	const out = envfile.updateManaged(text, { SECRET_BRIDGE_NEW_2: "https://new.test/x.ics?a=1#b" });
	const parsed = envfile.parse(out);
	assert.equal(parsed.SECRET_OWM_KEY, "abc");
	assert.equal(parsed.HOME_LAT, "1");
	assert.equal(parsed.SECRET_BRIDGE_OLD_1, undefined);
	assert.equal(parsed.SECRET_BRIDGE_NEW_2, "https://new.test/x.ics?a=1#b");
	assert.ok(out.startsWith("# comment\n"));
	assert.throws(() => envfile.updateManaged(text, { SECRET_OWM_KEY: "x" }), /unmanaged/);
});

test("schemas: calendar validation", () => {
	const schema = bridge.SCHEMAS["MMM-MyGCalendar"].config;
	assert.deepEqual(validate(schema, { calendars: [{ name: "A", url: "webcal://x.test/a.ics", color: "#112233" }], defaultView: "week" }), []);
	assert.deepEqual(validate(schema, { calendars: [{ name: "A", url: "**SECRET_CAL_FAMILY**", color: "#112233" }] }), [], "placeholder accepted for x-secret");
	const errors = validate(schema, { calendars: [{ name: "", url: "ftp://x", color: "red" }], defaultView: "year", extra: 1 });
	assert.ok(errors.some((e) => e.includes("name")));
	assert.ok(errors.some((e) => e.includes("url")));
	assert.ok(errors.some((e) => e.includes("color")));
	assert.ok(errors.some((e) => e.includes("defaultView")));
	assert.ok(errors.some((e) => e.includes("extra")));
	assert.ok(validate(schema, { colorRules: [{ keyword: "(", color: "#123456" }] }).length > 0, "bad regex rejected");
});

test("schemas: sports league must be a code the scoreboard module supports", () => {
	const schema = bridge.SCHEMAS["MMM-MyScoreboard"].config;
	assert.deepEqual(validate(schema, { sports: [{ league: "NFL", teams: ["BUF"] }, { league: "English Premier League" }] }), []);
	assert.ok(validate(schema, { sports: [{ league: "NFLX" }] }).some((e) => e.includes("league")));
	assert.ok(validate(schema, { sports: [{ teams: ["BUF"] }] }).some((e) => e.includes("league is required")));
});

test("every schema file parses and declares an object config", () => {
	assert.deepEqual(Object.keys(bridge.SCHEMAS).sort(), ["MMM-GlobeWeatherBridge", "MMM-GuestNet", "MMM-MyGCalendar", "MMM-MyScoreboard", "MMM-TodoList"]);
	for (const [name, schema] of Object.entries(bridge.SCHEMAS)) {
		assert.equal(schema.config.type, "object", name);
	}
});

test("prepareOverrides turns raw URLs into managed secrets and blocks foreign placeholders", () => {
	const env = { SECRET_CAL_FAMILY: "https://fam.test/a.ics", SECRET_GOOGLE_MAPS_KEY: "AIzaKEY" };
	const allowed = new Set(["SECRET_CAL_FAMILY"]);
	const ok = bridge.prepareOverrides({
		"MMM-MyGCalendar": { calendars: [
			{ name: "Family", url: "**SECRET_CAL_FAMILY**", color: "#33B679" },
			{ name: "New", url: "https://new.test/b.ics", color: "#4285F4" },
			{ name: "Same", url: "https://fam.test/a.ics", color: "#4285F4" }
		] }
	}, env, allowed);
	assert.deepEqual(ok.errors, []);
	const cals = ok.overrides["MMM-MyGCalendar"].calendars;
	assert.equal(cals[0].url, "**SECRET_CAL_FAMILY**");
	assert.match(cals[1].url, /^\*\*SECRET_BRIDGE_MYGCALENDAR_[0-9A-F]{6}\*\*$/);
	assert.equal(cals[2].url, "**SECRET_CAL_FAMILY**", "known value reuses its existing secret");
	assert.equal(Object.values(ok.managed)[0], "https://new.test/b.ics");
	assert.ok(!JSON.stringify(ok.overrides).includes("new.test"), "raw URL never stored in overrides");

	const evil = bridge.prepareOverrides({ "MMM-MyGCalendar": { calendars: [{ name: "x", url: "**SECRET_GOOGLE_MAPS_KEY**", color: "#000000" }] } }, env, allowed);
	assert.ok(evil.errors.some((e) => e.includes("cannot be used")));

	const unknown = bridge.prepareOverrides({ "MMM-Nope": {} }, env, allowed);
	assert.ok(unknown.errors.some((e) => e.includes("not bridge editable")));
});

test("isSubset: objects partial, arrays exact", () => {
	assert.equal(bridge.isSubset({ a: 1, b: { c: [1, 2] } }, { a: 1, z: 0, b: { c: [1, 2], d: 1 } }), true);
	assert.equal(bridge.isSubset({ b: { c: [1] } }, { b: { c: [1, 2] } }), false);
});

test("Tailscale address checks", () => {
	assert.equal(net.isTailscaleAddress("100.64.0.1"), true);
	assert.equal(net.isTailscaleAddress("100.127.255.254"), true);
	assert.equal(net.isTailscaleAddress("100.128.0.1"), false);
	assert.equal(net.isTailscaleAddress("::ffff:100.100.1.2"), true);
	assert.equal(net.isTailscaleAddress("fd7a:115c:a1e0::1"), true);
	assert.equal(net.isTailscaleAddress("192.168.1.10"), false);
	assert.equal(net.isLoopback("::ffff:127.0.0.1"), true);
});

test("store: atomic write, backup, restore", async () => {
	const mmConfigDir = path.join(tmp, "cfg");
	fs.mkdirSync(mmConfigDir, { recursive: true });
	const store = new Store({ mmConfigDir, stateDir: path.join(tmp, "st"), keepBackups: 2 });
	await store.init();
	await store.writeBridge({ A: { x: 1 } });
	await store.writeEnv("SECRET_A=1\n");
	const id = await store.backup();
	await store.writeBridge({ A: { x: 2 } });
	await store.writeEnv("SECRET_A=2\n");
	await store.restore(id);
	assert.deepEqual((await store.readBridge()).data, { A: { x: 1 } });
	assert.equal(await store.readEnv(), "SECRET_A=1\n");
	assert.equal(fs.statSync(path.join(mmConfigDir, "config.env")).mode & 0o777, 0o600);
	await store.backup();
	await new Promise((r) => setTimeout(r, 5));
	await store.backup();
	assert.equal((await store.listBackups()).length, 2, "pruned to keepBackups");
});
