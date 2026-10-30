/* Screen guard for MagicMirror's Electron window.
 *
 * MagicMirror 2.38 (js/electron.js) has no handler for a page process that
 * crashes, is killed (for example out of memory) or hangs, nor for a crashed
 * GPU process. The window then stays blank or frozen until someone pulls the
 * plug. The guard exits instead, and systemd (Restart=on-failure in
 * magicmirror.service) starts MagicMirror again a few seconds later. It does
 * not reload in place: after an out-of-memory kill a reload tends to run out
 * of memory again, and a fresh process also frees the GPU.
 *
 * Events: Electron webContents "render-process-gone", BrowserWindow
 * "unresponsive" / "responsive", app "child-process-gone" (GPU only).
 * Kept free of MagicMirror and Electron imports so tests run without them.
 */
"use strict";

const IGNORED_REASONS = new Set(["clean-exit"]);

/**
 * @param {object} o
 * @param {object} o.app Electron app (an EventEmitter in tests)
 * @param {Function} o.windows returns the open BrowserWindows
 * @param {Function} o.exit called with (code) to end the process
 * @param {object} o.log { warn, error }
 * @param {Function} [o.metrics] returns app.getAppMetrics()
 * @param {number} [o.unresponsiveMs] how long a hung page is given before restarting
 */
function install ({ app, windows, exit, log, metrics = () => [], unresponsiveMs = 60 * 1000 }) {
	let quitting = false;
	let restarting = false;
	const watched = new WeakSet();

	function memorySummary () {
		try {
			// workingSetSize is in kilobytes (Electron MemoryInfo).
			return metrics().map((m) => m.type + " " + Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024) + " MB").join(", ");
		} catch {
			return "unknown";
		}
	}

	function restart (reason) {
		if (quitting || restarting) return;
		restarting = true;
		log.error("MMM-Guard: " + reason + ". Memory: " + memorySummary() + ". Exiting so systemd restarts MagicMirror.");
		exit(1);
	}

	function watchWindow (win) {
		if (!win || watched.has(win)) return;
		watched.add(win);
		let hungTimer = null;
		win.webContents.on("render-process-gone", (_ev, details) => {
			const reason = (details && details.reason) || "unknown";
			if (IGNORED_REASONS.has(reason)) return;
			restart("page process gone (" + reason + ", exit code " + (details && details.exitCode) + ")");
		});
		win.on("unresponsive", () => {
			if (hungTimer) return;
			log.warn("MMM-Guard: page not responding, restarting in " + Math.round(unresponsiveMs / 1000) + " s unless it recovers");
			hungTimer = setTimeout(() => restart("page not responding for " + Math.round(unresponsiveMs / 1000) + " s"), unresponsiveMs);
		});
		win.on("responsive", () => {
			if (!hungTimer) return;
			clearTimeout(hungTimer);
			hungTimer = null;
			log.warn("MMM-Guard: page responding again");
		});
		win.on("closed", () => {
			clearTimeout(hungTimer);
			hungTimer = null;
		});
	}

	app.on("before-quit", () => {
		quitting = true;
	});
	app.on("browser-window-created", (_ev, win) => watchWindow(win));
	app.on("child-process-gone", (_ev, details) => {
		const type = details && details.type;
		const reason = (details && details.reason) || "unknown";
		if (type !== "GPU" || IGNORED_REASONS.has(reason)) return;
		restart("GPU process gone (" + reason + ", exit code " + (details && details.exitCode) + ")");
	});
	for (const win of windows()) watchWindow(win);
}

module.exports = { install };
