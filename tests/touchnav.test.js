/* MMM-TouchNav: when the fridge goes back to the Home page by itself.
 * Loads the real module file with a stub Module.register, no browser needed.
 * Run: node --test tests/touchnav.test.js */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadTouchNav () {
	let def;
	const file = path.join(__dirname, "..", "modules", "MMM-TouchNav", "MMM-TouchNav.js");
	vm.runInNewContext(fs.readFileSync(file, "utf-8"), { Module: { register: (name, d) => { def = d; } } }, { filename: file });
	return Object.assign(Object.create(def), { config: { ...def.defaults } });
}

const MIN = 60 * 1000;
const base = { page: 2, homePage: 0, castPage: 1, idleMs: 0, onPageMs: 0, casting: false, keyboardOpen: false, popupOpen: false };

test("Sports left alone for 5 minutes goes back to Home", () => {
	const nav = loadTouchNav();
	assert.equal(nav.shouldReturnHome({ ...base, idleMs: 4 * MIN }), false);
	assert.equal(nav.shouldReturnHome({ ...base, idleMs: 5 * MIN }), true);
});

test("Home stays Home, and a playing cast is never cut off", () => {
	const nav = loadTouchNav();
	assert.equal(nav.shouldReturnHome({ ...base, page: 0, idleMs: 60 * MIN }), false);
	assert.equal(nav.shouldReturnHome({ ...base, page: 1, casting: true, idleMs: 60 * MIN }), false);
	assert.equal(nav.shouldReturnHome({ ...base, page: 1, casting: false, idleMs: 5 * MIN }), true, "idle Cast page with nothing playing");
});

test("an open keyboard or popup gets 15 minutes", () => {
	const nav = loadTouchNav();
	assert.equal(nav.shouldReturnHome({ ...base, keyboardOpen: true, idleMs: 10 * MIN }), false);
	assert.equal(nav.shouldReturnHome({ ...base, popupOpen: true, idleMs: 15 * MIN }), true);
});
