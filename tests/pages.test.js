/* Page switching with the real MMM-pages code (third party, so not in this
 * repo): two page changes close together must leave exactly one page on
 * screen. Before patches/MMM-pages.patch, a show still pending from the first
 * change put the Sports page beside the calendar (2026-10-26).
 * Run on the Pi:   node --test tests/pages.test.js
 * Run elsewhere:   MMM_PAGES_DIR=/path/to/patched/MMM-pages node --test tests/pages.test.js
 * Skipped when no MMM-pages checkout is found. */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const pagesDir = process.env.MMM_PAGES_DIR || path.join(process.env.MM_DIR || path.join(os.homedir(), "MagicMirror"), "modules", "MMM-pages");
const pagesFile = path.join(pagesDir, "MMM-pages.js");

// The pages and fixed modules from config/config.js.
const PAGES = [
	["MMM-MyGCalendar", "split-home", "MMM-TodoList", "MMM-HomeWeather"],
	["MMM-YouTubeCast"],
	["MMM-MyScoreboard", "split-sports", "MMM-GameDetails"]
];
const FIXED = ["MMM-page-indicator", "MMM-TouchNav"];
const ON_SCREEN = [
	["MMM-page-indicator"], ["MMM-TouchNav"],
	["MMM-MyGCalendar"], ["MMM-SplitLayout", "split-home"], ["MMM-TodoList"], ["MMM-HomeWeather"],
	["MMM-YouTubeCast"],
	["MMM-MyScoreboard"], ["MMM-SplitLayout", "split-sports"], ["MMM-GameDetails"]
];

// Lock string rules of MagicMirror 2.38 js/main.js _hideModule/_showModule:
// hide adds the lock, show removes it and shows only when no lock is left.
function fakeModule ([name, extraClass], i) {
	return {
		name,
		identifier: "module_" + i + "_" + name,
		label: extraClass || name,
		// js/loader.js: classes = "<config classes> <module name>"
		data: { classes: extraClass ? extraClass + " " + name : name },
		lockStrings: [],
		hidden: false,
		hide (speed, cb, opts) {
			if (opts && opts.lockString && !this.lockStrings.includes(opts.lockString)) this.lockStrings.push(opts.lockString);
			this.hidden = true;
		},
		show (speed, cb, opts) {
			if (opts && opts.lockString) this.lockStrings = this.lockStrings.filter((s) => s !== opts.lockString);
			if (this.lockStrings.length === 0) this.hidden = false;
		}
	};
}

function collection (list) {
	// js/main.js modulesByClass: match any search class against the module's classes.
	const has = (m, names) => [].concat(names).some((c) => m.data.classes.toLowerCase().split(" ").includes(c.toLowerCase()));
	return {
		withClass: (names) => collection(list.filter((m) => has(m, names))),
		exceptWithClass: (names) => collection(list.filter((m) => !has(m, names))),
		enumerate: (fn) => list.forEach(fn)
	};
}

function loadPages (timers) {
	let def;
	const modules = ON_SCREEN.map(fakeModule);
	const sandbox = {
		Module: { register: (name, d) => { def = d; } },
		MM: { getModules: () => collection(modules) },
		Log: { log () {}, debug () {}, info () {}, warn () {}, error () {} },
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		setInterval: timers.setInterval,
		clearInterval: timers.clearInterval
	};
	vm.runInNewContext(fs.readFileSync(pagesFile, "utf-8"), sandbox, { filename: pagesFile });
	const pages = Object.assign(Object.create(def), {
		identifier: "module_0_MMM-pages",
		config: { ...def.defaults, modules: PAGES, fixed: FIXED, animationTime: 250, timings: { default: 0 }, homePage: 0 },
		sendNotification () {}
	});
	pages.start();
	const visible = () => modules.filter((m) => !m.hidden).map((m) => m.label).sort();
	return { pages, visible };
}

const expectPage = (n) => FIXED.concat(PAGES[n]).sort();

test("two quick page changes leave only the last page on screen", { skip: !fs.existsSync(pagesFile) && "no MMM-pages checkout at " + pagesDir }, (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const { pages, visible } = loadPages(globalThis);
	pages.notificationReceived("DOM_OBJECTS_CREATED");
	t.mock.timers.tick(1000);
	assert.deepEqual(visible(), expectPage(0), "starts on Home");

	// Sports, then Home again 50 ms later (inside the 125 ms show delay).
	pages.notificationReceived("PAGE_SELECT", 2);
	t.mock.timers.tick(50);
	pages.notificationReceived("PAGE_SELECT", 0);
	t.mock.timers.tick(1000);
	assert.deepEqual(visible(), expectPage(0), "Sports must not stay beside the calendar");

	// Two quick swipes: Home -> Cast -> Sports.
	pages.notificationReceived("PAGE_INCREMENT", 1);
	t.mock.timers.tick(20);
	pages.notificationReceived("PAGE_INCREMENT", 1);
	t.mock.timers.tick(1000);
	assert.deepEqual(visible(), expectPage(2), "Cast must not stay under Sports");

	// A slow change still works as before.
	pages.notificationReceived("PAGE_SELECT", 1);
	t.mock.timers.tick(1000);
	assert.deepEqual(visible(), expectPage(1));
});
