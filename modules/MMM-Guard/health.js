/* Early warnings for the screen (MMM-Guard.js shows them as a strip): a failing
 * SD card, a power supply that is too weak, or a nearly full disk.
 * On 2026-10-25 the card started failing to read /usr/lib/aarch64-linux-gnu;
 * the kernel counted 6.9 million ext4 errors over 34 hours and nothing on the
 * screen said so, until the Pi no longer started.
 * The pure parts are exported for tests. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

// vcgencmd get_throttled bits (Raspberry Pi documentation, "vcgencmd").
const UNDERVOLT_NOW = 0x1;
const UNDERVOLT_SINCE_BOOT = 0x10000;

/** "throttled=0x50005" -> 327685, anything else -> null */
function parseThrottled (out) {
	const m = /throttled=(0x[0-9a-f]+)/i.exec(String(out));
	return m ? parseInt(m[1], 16) : null;
}

/**
 * @param {object} s
 * @param {number|null} s.fsErrors ext4 errors since the filesystem was made (null: unknown)
 * @param {number|null} s.throttled vcgencmd get_throttled bits (null: unknown)
 * @param {number} [s.freeBytes] free space on / for normal users
 * @param {number} [s.totalBytes] size of /
 * @returns {{id: string, text: string}[]}
 */
function warningsFrom ({ fsErrors, throttled, freeBytes, totalBytes }) {
	const out = [];
	if (fsErrors > 0) out.push({ id: "card", text: "SD card errors (" + fsErrors + "): the card is failing. Replace it soon (README: Replacing the SD card)." });
	if (Number.isInteger(throttled) && (throttled & (UNDERVOLT_NOW | UNDERVOLT_SINCE_BOOT))) out.push({ id: "power", text: "Power too weak (under-voltage). Use the Raspberry Pi 5.1 V 3 A power supply." });
	if (totalBytes > 0 && freeBytes / totalBytes < 0.1) out.push({ id: "disk", text: "Storage almost full (" + Math.round((100 * freeBytes) / totalBytes) + "% free)." });
	return out;
}

/** Sum of errors_count over the ext4 filesystems in sysfs, or null when there is none to read. */
function readFsErrors (root = "/sys/fs/ext4") {
	let dirs;
	try {
		dirs = fs.readdirSync(root);
	} catch {
		return null;
	}
	let total = null;
	for (const d of dirs) {
		try {
			const n = parseInt(fs.readFileSync(path.join(root, d, "errors_count"), "utf8"), 10);
			if (Number.isFinite(n)) total = (total || 0) + n;
		} catch {
			// not a filesystem folder (for example "features")
		}
	}
	return total;
}

function readThrottled () {
	return new Promise((resolve) => {
		execFile("vcgencmd", ["get_throttled"], { timeout: 5000 }, (err, stdout) => resolve(err ? null : parseThrottled(stdout)));
	});
}

async function readDisk (p = "/") {
	try {
		const s = await fs.promises.statfs(p);
		return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
	} catch {
		return {};
	}
}

/** @returns {Promise<{warnings: object[], fsErrors: number|null, throttled: number|null}>} */
async function check () {
	const [throttled, disk] = await Promise.all([readThrottled(), readDisk()]);
	const fsErrors = readFsErrors();
	return { warnings: warningsFrom(Object.assign({ fsErrors, throttled }, disk)), fsErrors, throttled };
}

module.exports = { parseThrottled, warningsFrom, readFsErrors, check };
