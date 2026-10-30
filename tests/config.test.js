/* config/config.js: the weather line is there only when its key and location
 * are set, only on the Home page, and neither the key nor the location is in
 * the config the browser gets.
 * Run: node --test tests/config.test.js */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CONFIG = path.join(ROOT, "config", "config.js");
const VARS = ["SECRET_GOOGLE_MAPS_KEY", "HOME_LAT", "HOME_LNG"];

function loadConfig (env) {
	const saved = {};
	for (const k of VARS) {
		saved[k] = process.env[k];
		if (env[k] === undefined) delete process.env[k];
		else process.env[k] = env[k];
	}
	global.root_path = ROOT;
	delete require.cache[CONFIG];
	try {
		return require(CONFIG);
	} finally {
		for (const k of VARS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

const weatherOf = (c) => c.modules.filter((m) => m.module === "MMM-HomeWeather");
const pagesOf = (c) => c.modules.find((m) => m.module === "MMM-pages").config;

test("weather line only with a key and a home location", () => {
	assert.equal(weatherOf(loadConfig({})).length, 0);
	assert.equal(weatherOf(loadConfig({ SECRET_GOOGLE_MAPS_KEY: "k".repeat(39) })).length, 0, "no location");
	assert.equal(weatherOf(loadConfig({ HOME_LAT: "41.88", HOME_LNG: "-87.63" })).length, 0, "no key");
	const c = loadConfig({ SECRET_GOOGLE_MAPS_KEY: "test-weather-key-not-real", HOME_LAT: "41.87811", HOME_LNG: "-87.62980" });
	const [wl] = weatherOf(c);
	assert.equal(wl.position, "top_right");
	const text = JSON.stringify(c);
	assert.ok(!text.includes("test-weather-key"), "key not in the config");
	assert.ok(!text.includes("41.87") && !text.includes("-87.6"), "location not in the config");
});

test("weather line is on the Home page only", () => {
	const p = pagesOf(loadConfig({}));
	assert.ok(p.modules[p.homePage].includes("MMM-HomeWeather"));
	assert.ok(!p.fixed.includes("MMM-HomeWeather"));
	for (let i = 0; i < p.modules.length; i++) if (i !== p.homePage) assert.ok(!p.modules[i].includes("MMM-HomeWeather"));
});
