/* MMM-GuestNet node_helper
 *
 * - Network status for the top bar icon: NetworkManager (nmcli, standard on
 *   Raspberry Pi OS Bookworm and later) says whether the Pi is on Wi-Fi or a
 *   cable and how strong the Wi-Fi is. A TCP connect to a public DNS server
 *   says whether the internet is reachable.
 * - Guest Wi-Fi QR: built here as SVG with the `qrcode` package. SSID and
 *   password come from the admin page, else GUEST_WIFI_SSID /
 *   GUEST_WIFI_PASSWORD in config.env. They are shown on screen by design.
 */
"use strict";

const net = require("node:net");
const { execFile } = require("node:child_process");
const NodeHelper = require("node_helper");
const Log = require("logger");
const QRCode = require("qrcode");
const { wifiString, unsetValue } = require("./wifiqr");

function run (cmd, args) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout)));
	});
}

/** nmcli -t output: fields split on ":" with "\:" escaped. */
function splitTerse (line) {
	const out = [];
	let cur = "";
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "\\" && i + 1 < line.length) {
			cur += line[++i];
		} else if (line[i] === ":") {
			out.push(cur);
			cur = "";
		} else {
			cur += line[i];
		}
	}
	out.push(cur);
	return out;
}

function reachable (host, port, ms) {
	return new Promise((resolve) => {
		const sock = net.connect({ host, port });
		const done = (ok) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(ms, () => done(false));
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
	});
}

module.exports = NodeHelper.create({
	start () {
		this.timer = null;
		this.config = null;
	},

	stop () {
		clearInterval(this.timer);
	},

	async status () {
		let kind = "unknown";
		let signal = null;
		const devices = await run("nmcli", ["-t", "-f", "TYPE,STATE", "device"]);
		if (devices !== null) {
			kind = "none";
			for (const line of devices.split("\n")) {
				const [type, state] = splitTerse(line);
				if (state !== "connected") continue;
				if (type === "ethernet") {
					kind = "ethernet";
					break;
				}
				if (type === "wifi") kind = "wifi";
			}
			if (kind === "wifi") {
				const list = await run("nmcli", ["-t", "-f", "IN-USE,SIGNAL", "device", "wifi", "list", "--rescan", "no"]);
				const inUse = (list || "").split("\n").map(splitTerse).find((f) => f[0] === "*");
				if (inUse) signal = Number(inUse[1]);
			}
		}
		// DNS over TCP first; some routers block it, so HTTPS is the last try.
		const online = (await reachable("1.1.1.1", 53, 3000)) || (await reachable("8.8.8.8", 53, 3000)) || (await reachable("1.1.1.1", 443, 3000));
		return { kind, signal: Number.isFinite(signal) ? signal : null, online };
	},

	async sendStatus () {
		try {
			this.sendSocketNotification("GN_STATUS", await this.status());
		} catch (err) {
			Log.warn("[MMM-GuestNet] status check failed: " + err.message);
		}
	},

	guestNetwork () {
		const c = this.config || {};
		const ssid = unsetValue(c.ssid) ? process.env.GUEST_WIFI_SSID : c.ssid;
		const password = unsetValue(c.password) ? process.env.GUEST_WIFI_PASSWORD : c.password;
		return { ssid: unsetValue(ssid) ? "" : String(ssid), password: unsetValue(password) ? "" : String(password), security: c.security || "WPA", hidden: Boolean(c.hidden) };
	},

	async sendGuest () {
		const guest = this.guestNetwork();
		const text = wifiString(guest);
		if (!text) {
			this.sendSocketNotification("GN_GUEST", { error: "No guest network set. Add it in the admin page (Guest Wi-Fi) or GUEST_WIFI_SSID in config.env." });
			return;
		}
		try {
			const svg = await QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2, color: { dark: "#000000", light: "#ffffff" } });
			this.sendSocketNotification("GN_GUEST", {
				ssid: guest.ssid,
				password: guest.security === "nopass" ? "" : guest.password,
				svg
			});
		} catch (err) {
			Log.error("[MMM-GuestNet] QR failed: " + err.message);
			this.sendSocketNotification("GN_GUEST", { error: "Could not draw the QR code: " + err.message });
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "GN_INIT") {
			this.config = payload || {};
			this.sendStatus();
			this.sendGuest();
			clearInterval(this.timer);
			this.timer = setInterval(() => this.sendStatus(), Math.max(10000, Number(this.config.updateInterval) || 30000));
		} else if (notification === "GN_GUEST_REQUEST") {
			this.sendGuest();
		}
	}
});
