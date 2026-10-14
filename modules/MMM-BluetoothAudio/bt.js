/* Bluetooth and audio output helpers for MMM-BluetoothAudio.
 *
 * Talks to BlueZ through `bluetoothctl` and to PipeWire through `pw-dump`
 * and `wpctl`, all standard on Raspberry Pi OS (Bookworm and Trixie).
 * Commands run with execFile (no shell); MAC addresses are validated first.
 * Parsing is kept in pure functions so tests run without a Pi.
 */
"use strict";

const { execFile, spawn } = require("node:child_process");

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

function isMac (value) {
	return typeof value === "string" && MAC_RE.test(value.toUpperCase());
}

/** BlueZ names a device that announces no name after its address, written
 * with dashes ("42-C9-41-BC-2A-8D"). Those are nameless, not real names. */
function isRealName (name) {
	const n = String(name || "").trim();
	return n !== "" && !/^([0-9A-F]{2}[-:]){5}[0-9A-F]{2}$/i.test(n);
}

function run (cmd, args, timeoutMs = 10000) {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || (err && err.message) || "") });
		});
	});
}

// Terminal colour codes bluetoothctl adds even when piped.
function plain (text) {
	return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

/** "Device AA:BB:CC:DD:EE:FF Name" lines -> [{ mac, name }] */
function parseDevices (text) {
	const out = [];
	for (const line of plain(text).split("\n")) {
		const m = /^Device ([0-9A-Fa-f:]{17})\s*(.*)$/.exec(line.trim());
		if (m && isMac(m[1])) out.push({ mac: m[1].toUpperCase(), name: m[2].trim() });
	}
	return out;
}

/** `bluetoothctl info MAC` -> the fields we use */
function parseInfo (text) {
	const info = { name: "", paired: false, trusted: false, connected: false, icon: "", uuids: [] };
	for (const raw of plain(text).split("\n")) {
		const line = raw.trim();
		const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
		if (!m) continue;
		const [, key, value] = m;
		if (key === "Alias" || (key === "Name" && !info.name)) info.name = value;
		else if (key === "Paired") info.paired = value === "yes";
		else if (key === "Trusted") info.trusted = value === "yes";
		else if (key === "Connected") info.connected = value === "yes";
		else if (key === "Icon") info.icon = value;
		else if (key === "UUID") info.uuids.push(value);
	}
	// Speakers and headphones: an audio icon, or the A2DP "Audio Sink" profile.
	info.audio = info.icon.startsWith("audio") || info.uuids.some((u) => /Audio Sink|0000110b/i.test(u));
	return info;
}

/** `bluetoothctl show` -> { present, powered } */
function parseShow (text) {
	const t = plain(text);
	return { present: /Controller [0-9A-Fa-f:]{17}/.test(t), powered: /Powered:\s*yes/.test(t) };
}

/**
 * From `pw-dump` JSON: the PipeWire sink of a Bluetooth device, and the
 * current default sink's description.
 */
function parsePwDump (json) {
	let items;
	try {
		items = JSON.parse(json);
	} catch {
		return { sinks: [], defaultName: null };
	}
	const sinks = [];
	let defaultName = null;
	for (const it of Array.isArray(items) ? items : []) {
		const props = it && it.info && it.info.props;
		if (it.type === "PipeWire:Interface:Node" && props && props["media.class"] === "Audio/Sink") {
			sinks.push({
				id: it.id,
				name: props["node.name"] || "",
				description: props["node.description"] || props["node.nick"] || props["node.name"] || "",
				btAddress: props["api.bluez5.address"] ? String(props["api.bluez5.address"]).toUpperCase() : null
			});
		}
		if (it.type === "PipeWire:Interface:Metadata" && it.props && it.props["metadata.name"] === "default") {
			for (const entry of it.metadata || []) {
				if (entry.key === "default.audio.sink" && entry.value) {
					defaultName = typeof entry.value === "string" ? safeName(entry.value) : entry.value.name;
				}
			}
		}
	}
	return { sinks, defaultName };
}

function safeName (value) {
	try {
		return JSON.parse(value).name;
	} catch {
		return null;
	}
}

/** A friendlier label for the built-in outputs. */
function outputLabel (sink) {
	if (!sink) return "Nothing";
	if (sink.btAddress) return sink.description;
	if (/hdmi/i.test(sink.name + " " + sink.description)) return "Screen (HDMI)";
	if (/analog|stereo|headphones|bcm2835/i.test(sink.name + " " + sink.description)) return "Aux jack";
	return sink.description;
}

/**
 * Pairing needs an agent. A short interactive bluetoothctl session registers
 * a "NoInputNoOutput" agent (speakers have no keypad), then pairs, trusts and
 * connects. Resolves with the session output.
 */
function pairSession (mac, timeoutMs = 45000) {
	return new Promise((resolve) => {
		const child = spawn("bluetoothctl", [], { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			try {
				child.stdin.end("quit\n");
			} catch {
				// already gone
			}
			setTimeout(() => child.kill(), 1000);
			resolve(plain(out));
		};
		const timer = setTimeout(finish, timeoutMs);
		const steps = [
			{ send: "agent NoInputNoOutput", wait: /Agent registered|already registered/i },
			{ send: "default-agent", wait: /Default agent request successful|No agent/i },
			{ send: "pair " + mac, wait: /Pairing successful|AlreadyExists|Failed to pair|not available/i },
			{ send: "trust " + mac, wait: /trust succeeded|Changing .* succeeded|not available/i },
			{ send: "connect " + mac, wait: /Connection successful|Failed to connect|not available/i }
		];
		let step = -1;
		const next = () => {
			step += 1;
			if (step >= steps.length) return finish();
			child.stdin.write(steps[step].send + "\n");
		};
		child.stdout.on("data", (d) => {
			out += d;
			if (step >= 0 && step < steps.length && steps[step].wait.test(plain(out).split(steps[step].send).pop())) next();
		});
		child.on("error", () => finish());
		child.on("close", () => finish());
		setTimeout(next, 500);
	});
}

module.exports = { MAC_RE, isMac, isRealName, run, plain, parseDevices, parseInfo, parseShow, parsePwDump, outputLabel, pairSession };
