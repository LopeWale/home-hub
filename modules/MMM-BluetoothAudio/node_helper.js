/* MMM-BluetoothAudio node_helper
 *
 * - Lists paired speakers, scans for new ones, pairs, connects, disconnects
 *   and forgets them (bluetoothctl).
 * - When a speaker connects, makes it the default sound output (PipeWire), so
 *   casts and everything else play there. When it goes away PipeWire falls
 *   back to the next output (the aux jack).
 * - Remembers the chosen speaker in data/bluetooth.json. The speaker is
 *   allowed to sleep: it is connected again only when something starts
 *   playing (BTA_WAKE from the cast), never on a timer, so an idle speaker is
 *   not woken all day. Disconnect in the popup forgets that choice.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const bt = require("./bt");

module.exports = NodeHelper.create({
	start () {
		this.file = path.join(this.path, "data", "bluetooth.json");
		this.saved = this.load();
		this.found = new Map(); // mac -> name, from the last scan
		this.busy = null; // "scanning" | "pairing" | "connecting" | null
		this.message = "";
		this.timer = null;
	},

	stop () {
		clearInterval(this.timer);
	},

	load () {
		try {
			const d = JSON.parse(fs.readFileSync(this.file, "utf-8"));
			return { preferred: bt.isMac(d.preferred) ? d.preferred : null };
		} catch {
			return { preferred: null };
		}
	},

	save () {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.saved, null, 2));
			fs.renameSync(this.file + ".tmp", this.file);
		} catch (err) {
			Log.warn("[MMM-BluetoothAudio] could not save: " + err.message);
		}
	},

	// ---------- state ----------

	async audio () {
		const dump = await bt.run("pw-dump", [], 8000);
		return bt.parsePwDump(dump.out);
	},

	async state () {
		const show = await bt.run("bluetoothctl", ["show"]);
		const ctl = bt.parseShow(show.out);
		const devices = [];
		if (ctl.present) {
			const paired = bt.parseDevices((await bt.run("bluetoothctl", ["devices", "Paired"])).out);
			const macs = new Set(paired.map((d) => d.mac));
			for (const mac of this.found.keys()) macs.add(mac);
			for (const mac of macs) {
				const info = bt.parseInfo((await bt.run("bluetoothctl", ["info", mac], 5000)).out);
				const named = [info.name, this.found.get(mac)].find(bt.isRealName);
				// Nearby phones, watches and earbuds broadcast without a name (BlueZ then
				// shows their address). Unpaired devices are listed only with a real name;
				// a nameless one that says it is a speaker gets a plain label.
				if (!info.paired && !named && !info.audio) continue;
				const name = named || (info.audio ? "Unnamed speaker (" + mac.slice(-5) + ")" : "Unnamed device (" + mac.slice(-5) + ")");
				devices.push({ mac, name, paired: info.paired, connected: info.connected, audio: info.audio });
			}
			devices.sort((a, b) => Number(b.connected) - Number(a.connected) || Number(b.paired) - Number(a.paired) || Number(b.audio) - Number(a.audio) || a.name.localeCompare(b.name));
		}
		const { sinks, defaultName } = await this.audio();
		const current = sinks.find((s) => s.name === defaultName) || null;
		return {
			present: ctl.present,
			powered: ctl.powered,
			devices,
			output: bt.outputLabel(current),
			outputIsBluetooth: Boolean(current && current.btAddress),
			preferred: this.saved.preferred,
			busy: this.busy,
			message: this.message
		};
	},

	async send () {
		try {
			this.sendSocketNotification("BTA_STATE", await this.state());
		} catch (err) {
			Log.warn("[MMM-BluetoothAudio] state failed: " + err.message);
		}
	},

	setBusy (busy, message) {
		this.busy = busy;
		if (message !== undefined) this.message = message;
		this.send();
	},

	// ---------- actions ----------

	/** Wait for the speaker's PipeWire sink and make it the default output. */
	async routeTo (mac) {
		for (let i = 0; i < 10; i++) {
			const { sinks } = await this.audio();
			const sink = sinks.find((s) => s.btAddress === mac);
			if (sink) {
				const r = await bt.run("wpctl", ["set-default", String(sink.id)]);
				if (r.ok) return true;
			}
			await new Promise((res) => setTimeout(res, 1000));
		}
		return false;
	},

	async connect (mac) {
		const info = bt.parseInfo((await bt.run("bluetoothctl", ["info", mac], 5000)).out);
		let ok;
		if (!info.paired) {
			this.setBusy("pairing", "Pairing… put the speaker in pairing mode if it is not.");
			const out = await bt.pairSession(mac);
			ok = /Connection successful/i.test(out) || bt.parseInfo((await bt.run("bluetoothctl", ["info", mac], 5000)).out).connected;
			if (!ok) Log.warn("[MMM-BluetoothAudio] pairing " + mac + " did not finish: " + out.split("\n").filter((l) => /fail|error|not available/i.test(l)).slice(-2).join(" | "));
		} else {
			this.setBusy("connecting", "Connecting…");
			await bt.run("bluetoothctl", ["trust", mac]); // lets the speaker reconnect by itself too
			const r = await bt.run("bluetoothctl", ["connect", mac], 20000);
			ok = /Connection successful/i.test(r.out) || bt.parseInfo((await bt.run("bluetoothctl", ["info", mac], 5000)).out).connected;
		}
		if (!ok) {
			this.setBusy(null, "Could not connect. Is the speaker on and close to the fridge?");
			return;
		}
		this.saved.preferred = mac;
		this.save();
		const routed = await this.routeTo(mac);
		this.setBusy(null, routed ? "" : "Connected, but the sound system did not offer the speaker yet. Try again in a moment.");
		Log.log("[MMM-BluetoothAudio] connected " + mac + (routed ? ", sound now plays there" : ", sound not routed yet"));
	},

	async disconnect (mac) {
		// The user chose to stop using it: no automatic reconnect.
		if (this.saved.preferred === mac) {
			this.saved.preferred = null;
			this.save();
		}
		this.setBusy("connecting", "Disconnecting…");
		await bt.run("bluetoothctl", ["disconnect", mac], 10000);
		this.setBusy(null, "");
	},

	async forget (mac) {
		if (this.saved.preferred === mac) {
			this.saved.preferred = null;
			this.save();
		}
		await bt.run("bluetoothctl", ["remove", mac], 10000);
		this.found.delete(mac);
		this.send();
	},

	async scan () {
		this.setBusy("scanning", "Looking for speakers… put yours in pairing mode.");
		await bt.run("bluetoothctl", ["--timeout", "15", "scan", "on"], 20000);
		for (const d of bt.parseDevices((await bt.run("bluetoothctl", ["devices"])).out)) this.found.set(d.mac, d.name);
		this.setBusy(null, "");
	},

	/** If the chosen speaker is connected (the speaker can reconnect by itself,
	 * it is trusted), make sure the sound goes there. Local checks only: this
	 * never contacts the speaker, so it does not wake it. */
	async followSpeaker () {
		const mac = this.saved.preferred;
		if (!mac || this.busy) return;
		const info = bt.parseInfo((await bt.run("bluetoothctl", ["info", mac], 5000)).out);
		if (!info.connected) return;
		const { sinks, defaultName } = await this.audio();
		const sink = sinks.find((s) => s.btAddress === mac);
		if (sink && sink.name !== defaultName) {
			await bt.run("wpctl", ["set-default", String(sink.id)]);
			this.send();
		}
	},

	/** Something started playing: connect the chosen speaker if it is asleep.
	 * If it does not answer (switched off, away) the sound stays on the aux jack. */
	async wake () {
		const mac = this.saved.preferred;
		if (!mac || this.busy || this.waking) return;
		this.waking = true;
		try {
			const info = bt.parseInfo((await bt.run("bluetoothctl", ["info", mac], 5000)).out);
			if (info.connected) return await this.followSpeaker();
			const r = await bt.run("bluetoothctl", ["connect", mac], 15000);
			if (/Connection successful/i.test(r.out)) {
				Log.log("[MMM-BluetoothAudio] woke " + mac + " for playback");
				await this.routeTo(mac);
			} else {
				Log.log("[MMM-BluetoothAudio] " + mac + " did not answer; sound stays on the current output");
			}
			this.send();
		} finally {
			this.waking = false;
		}
	},

	async socketNotificationReceived (notification, payload) {
		try {
			if (notification === "BTA_INIT") {
				this.config = payload || {};
				clearInterval(this.timer);
				this.timer = setInterval(() => this.followSpeaker(), Math.max(30000, Number(this.config.checkMs) || 120000));
				this.send();
				return;
			}
			if (notification === "BTA_REFRESH") return this.send();
			if (notification === "BTA_WAKE") return await this.wake();
			if (this.busy) return; // one action at a time
			const mac = payload && typeof payload.mac === "string" ? payload.mac.toUpperCase() : null;
			if (notification === "BTA_POWER") {
				await bt.run("bluetoothctl", ["power", payload && payload.on ? "on" : "off"]);
				this.send();
			} else if (notification === "BTA_SCAN") {
				await this.scan();
			} else if (bt.isMac(mac)) {
				if (notification === "BTA_CONNECT") await this.connect(mac);
				else if (notification === "BTA_DISCONNECT") await this.disconnect(mac);
				else if (notification === "BTA_FORGET") await this.forget(mac);
			}
		} catch (err) {
			Log.error("[MMM-BluetoothAudio] " + notification + " failed: " + err.message);
			this.setBusy(null, "Something went wrong: " + err.message);
		}
	}
});
