/* MMM-Guard: which Electron events end the process (so systemd restarts
 * MagicMirror) and which do not, and the early warnings for the SD card, power
 * and disk. Fake Electron objects and a fake sysfs, no Pi needed.
 * Run: node --test tests/guard.test.js */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { install } = require("../modules/MMM-Guard/guard");

function setup (t) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const app = new EventEmitter();
	const win = new EventEmitter();
	win.webContents = new EventEmitter();
	const exits = [];
	const logs = [];
	install({
		app,
		windows: () => [win],
		exit: (code) => exits.push(code),
		log: { warn: (m) => logs.push(m), error: (m) => logs.push(m) },
		metrics: () => [{ type: "Browser", memory: { workingSetSize: 204800 } }, { type: "GPU", memory: { workingSetSize: 512000 } }],
		unresponsiveMs: 60000
	});
	return { app, win, exits, logs };
}

test("a crashed or killed page process exits with code 1, once", (t) => {
	const { win, exits, logs } = setup(t);
	win.webContents.emit("render-process-gone", {}, { reason: "oom", exitCode: 9 });
	win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
	assert.deepEqual(exits, [1]);
	assert.match(logs.at(-1), /page process gone \(oom, exit code 9\).*Browser 200 MB, GPU 500 MB/);
});

test("a clean page exit does not restart", (t) => {
	const { win, exits } = setup(t);
	win.webContents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
	assert.deepEqual(exits, []);
});

test("a hung page restarts after 60 s, a recovered one does not", (t) => {
	const { win, exits } = setup(t);
	win.emit("unresponsive");
	t.mock.timers.tick(30000);
	win.emit("responsive");
	t.mock.timers.tick(60000);
	assert.deepEqual(exits, [], "recovered within 60 s");
	win.emit("unresponsive");
	t.mock.timers.tick(59999);
	assert.deepEqual(exits, []);
	t.mock.timers.tick(1);
	assert.deepEqual(exits, [1]);
});

test("only GPU process crashes count among child processes", (t) => {
	const { app, exits } = setup(t);
	app.emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: 1 });
	app.emit("child-process-gone", {}, { type: "GPU", reason: "clean-exit", exitCode: 0 });
	assert.deepEqual(exits, []);
	app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 139 });
	assert.deepEqual(exits, [1]);
});

test("nothing restarts once MagicMirror is quitting", (t) => {
	const { app, win, exits } = setup(t);
	app.emit("before-quit");
	win.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 15 });
	app.emit("child-process-gone", {}, { type: "GPU", reason: "killed", exitCode: 15 });
	assert.deepEqual(exits, []);
});

test("windows created later are watched too", (t) => {
	const { app, exits } = setup(t);
	const late = new EventEmitter();
	late.webContents = new EventEmitter();
	app.emit("browser-window-created", {}, late);
	late.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
	assert.deepEqual(exits, [1]);
});

// ---------- early warnings: SD card, power, disk (health.js)
const health = require("../modules/MMM-Guard/health");

test("vcgencmd get_throttled output is read as bits", () => {
	assert.equal(health.parseThrottled("throttled=0x50005\n"), 0x50005);
	assert.equal(health.parseThrottled("throttled=0x0"), 0);
	assert.equal(health.parseThrottled("error"), null);
});

test("warnings: a failing card, weak power or a full disk, and nothing when healthy", () => {
	const ok = { fsErrors: 0, throttled: 0, freeBytes: 6e9, totalBytes: 15.6e9 };
	assert.deepEqual(health.warningsFrom(ok), []);
	assert.deepEqual(health.warningsFrom({ fsErrors: null, throttled: null }), [], "unknown is not a warning");
	// the 2026-10-25 card: 6,953,002 ext4 errors
	assert.deepEqual(health.warningsFrom({ ...ok, fsErrors: 6953002 }).map((x) => x.id), ["card"]);
	assert.deepEqual(health.warningsFrom({ ...ok, throttled: 0x50000 }).map((x) => x.id), ["power"], "under-voltage since boot");
	assert.deepEqual(health.warningsFrom({ ...ok, throttled: 0x1 }).map((x) => x.id), ["power"], "under-voltage now");
	assert.deepEqual(health.warningsFrom({ ...ok, throttled: 0x80008 }), [], "temperature limit alone is not a power warning");
	assert.match(health.warningsFrom({ ...ok, freeBytes: 1e9 })[0].text, /6% free/);
});

test("ext4 error counts are summed from sysfs; missing sysfs is unknown", () => {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext4-"));
	fs.mkdirSync(path.join(root, "mmcblk0p2"));
	fs.mkdirSync(path.join(root, "features"));
	fs.writeFileSync(path.join(root, "mmcblk0p2", "errors_count"), "12\n");
	assert.equal(health.readFsErrors(root), 12);
	fs.writeFileSync(path.join(root, "mmcblk0p2", "errors_count"), "0\n");
	assert.equal(health.readFsErrors(root), 0);
	assert.equal(health.readFsErrors(path.join(root, "nope")), null);
	fs.rmSync(root, { recursive: true, force: true });
});
