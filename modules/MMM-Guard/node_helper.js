/* MMM-Guard node_helper:
 * - restarts MagicMirror when its screen dies (see guard.js)
 * - every 10 minutes checks the SD card, the power supply and free space, and
 *   tells the screen when something is wrong (see health.js)
 * MagicMirror runs node helpers inside Electron's main process (js/electron.js
 * requires ./app), so the Electron API is available here. Started with
 * "node --run server" there is no Electron, and the restart guard stays off. */
"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");
const { install } = require("./guard");
const health = require("./health");

const HEALTH_FIRST_MS = 60 * 1000;
const HEALTH_EVERY_MS = 10 * 60 * 1000;

module.exports = NodeHelper.create({
	start () {
		this.warnings = [];
		setTimeout(() => this.checkHealth(), HEALTH_FIRST_MS);
		setInterval(() => this.checkHealth(), HEALTH_EVERY_MS);

		let electron = null;
		try {
			electron = require("electron");
		} catch {
			electron = null;
		}
		// Outside Electron, require("electron") is the npm package: a path string.
		if (!electron || !electron.app || typeof electron.app.on !== "function") {
			Log.log("[MMM-Guard] not running inside Electron, guard off");
			return;
		}
		const { app, BrowserWindow } = electron;
		install({
			app,
			windows: () => BrowserWindow.getAllWindows(),
			exit: (code) => app.exit(code),
			log: Log,
			metrics: () => app.getAppMetrics()
		});
		Log.log("[MMM-Guard] watching the MagicMirror window");
	},

	socketNotificationReceived (notification) {
		// A (re)loaded page asks for the current warnings.
		if (notification === "GUARD_HELLO") this.sendSocketNotification("GUARD_HEALTH", this.warnings);
	},

	async checkHealth () {
		let warnings;
		try {
			const r = await health.check();
			warnings = r.warnings;
			// Say once if a check cannot run, so "no warning" is not mistaken for "healthy".
			if (!this.reportedGaps) {
				this.reportedGaps = true;
				if (r.fsErrors === null) Log.warn("[MMM-Guard] SD card check unavailable: no ext4 error counter in /sys/fs/ext4");
				if (r.throttled === null) Log.warn("[MMM-Guard] power check unavailable: vcgencmd get_throttled gave no answer");
			}
		} catch (err) {
			Log.warn("[MMM-Guard] health check failed: " + err.message);
			return;
		}
		if (JSON.stringify(warnings) === JSON.stringify(this.warnings)) return;
		for (const w of warnings) Log.warn("[MMM-Guard] " + w.text);
		this.warnings = warnings;
		this.sendSocketNotification("GUARD_HEALTH", warnings);
	}
});
