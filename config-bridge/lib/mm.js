"use strict";

/*
 * Talks to the running MagicMirror instance (localhost only) and to
 * systemd. MagicMirror reads config.js and config.env once at startup
 * (js/utils.js loadConfig), so applying a change means restarting it.
 */

const { execFile } = require("node:child_process");
const path = require("node:path");
const { redactUrls } = require("./security");

class Mirror {
	constructor ({ mmDir, mmUrl, restartCmd }) {
		this.mmDir = mmDir;
		this.mmUrl = mmUrl.replace(/\/+$/, "");
		this.restartCmd = restartCmd;
	}

	async fetchText (route, timeoutMs = 4000) {
		const res = await fetch(this.mmUrl + route, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) throw new Error("MagicMirror " + route + " returned HTTP " + res.status);
		return res.text();
	}

	/** Startup timestamp. Changes on every MagicMirror restart. null if down. */
	async startup () {
		try {
			return await this.fetchText("/startup");
		} catch {
			return null;
		}
	}

	/** The redacted config MagicMirror serves to browsers (secrets are **SECRET_X**). */
	async liveConfig () {
		try {
			const config = JSON.parse(await this.fetchText("/config/", 6000));
			this.lastError = null;
			return config;
		} catch (err) {
			// Kept for /api/config/get so "mirror offline" can be diagnosed remotely.
			this.lastError = redactUrls((err.cause && err.cause.code) || err.message);
			return null;
		}
	}

	/** Run MagicMirror's own config checker (lint + module structure). */
	checkConfig () {
		return new Promise((resolve) => {
			execFile(process.execPath, [path.join(this.mmDir, "js", "check_config.js")], { cwd: this.mmDir, timeout: 90000 }, (err, stdout, stderr) => {
				const output = redactUrls((stdout || "") + (stderr || "")).split("\n").filter((line) => /error|warn|line \d+/i.test(line)).slice(0, 20).join("\n");
				resolve({ ok: !err, output });
			});
		});
	}

	restart () {
		const [cmd, ...args] = this.restartCmd;
		return new Promise((resolve, reject) => {
			execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
				if (err) reject(new Error("restart command failed: " + redactUrls(stderr || err.message).trim()));
				else resolve();
			});
		});
	}
}

module.exports = { Mirror };
