/* Unit tests for automatic home location helpers (no network).
 * Run: node --test tests/locate.test.js */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { splitTerse, parseNmcliWifi, isUniversalMac, percentToDbm, wifiAccessPoints } = require("../modules/MMM-GlobeWeatherBridge/locate");

test("splitTerse handles escaped colons and backslashes", () => {
	assert.deepEqual(splitTerse("Home\\:Net:AA\\:BB\\:CC\\:DD\\:EE\\:FF:72"), ["Home:Net", "AA:BB:CC:DD:EE:FF", "72"]);
	assert.deepEqual(splitTerse("a\\\\b:c"), ["a\\b", "c"]);
});

test("parseNmcliWifi reads SSID, BSSID and signal, skips junk", () => {
	const out = parseNmcliWifi([
		"Kitchen:A4\\:91\\:B1\\:00\\:11\\:22:80",
		":3C\\:84\\:6A\\:01\\:02\\:03:40", // hidden SSID
		"Weird\\:Name:10\\:20\\:30\\:40\\:50\\:60:55",
		"garbage line",
		""
	].join("\n"));
	assert.deepEqual(out, [
		{ ssid: "Kitchen", bssid: "A4:91:B1:00:11:22", signal: 80 },
		{ ssid: "", bssid: "3C:84:6A:01:02:03", signal: 40 },
		{ ssid: "Weird:Name", bssid: "10:20:30:40:50:60", signal: 55 }
	]);
});

test("isUniversalMac drops locally administered, broadcast and IANA reserved", () => {
	assert.equal(isUniversalMac("A4:91:B1:00:11:22"), true);
	assert.equal(isUniversalMac("A6:91:B1:00:11:22"), false, "locally administered bit set");
	assert.equal(isUniversalMac("FF:FF:FF:FF:FF:FF"), false);
	assert.equal(isUniversalMac("00:00:5E:00:01:01"), false);
});

test("percentToDbm maps nmcli 0..100 into the API dBm range", () => {
	assert.equal(percentToDbm(100), -50);
	assert.equal(percentToDbm(0), -100);
	assert.equal(percentToDbm(70), -65);
});

test("wifiAccessPoints filters, dedupes, honours _nomap and sorts strongest first", () => {
	const aps = wifiAccessPoints([
		{ ssid: "Home", bssid: "A4:91:B1:00:11:22", signal: 60 },
		{ ssid: "Home", bssid: "A4:91:B1:00:11:22", signal: 90 }, // same AP, stronger reading
		{ ssid: "Neighbour_nomap", bssid: "3C:84:6A:01:02:03", signal: 99 },
		{ ssid: "Phone hotspot", bssid: "A6:00:00:00:00:01", signal: 95 },
		{ ssid: "Cafe", bssid: "10:20:30:40:50:60", signal: 30 }
	]);
	assert.deepEqual(aps, [
		{ macAddress: "A4:91:B1:00:11:22", signalStrength: -55 },
		{ macAddress: "10:20:30:40:50:60", signalStrength: -85 }
	]);
	const many = Array.from({ length: 30 }, (_, i) => ({ ssid: "n" + i, bssid: "00:11:22:33:44:" + String(i).padStart(2, "0"), signal: i }));
	assert.equal(wifiAccessPoints(many).length, 20);
});
