/* Automatic home location for MMM-GlobeWeatherBridge.
 *
 * The Pi has no GPS, so:
 *   1. Wi-Fi positioning: list nearby Wi-Fi networks with nmcli and ask the
 *      Google Geolocation API (needs SECRET_GOOGLE_MAPS_KEY with the
 *      Geolocation API enabled). Usually close to the house.
 *   2. Internet lookup: free services guess from the public IP. City level.
 * Pure helpers are exported for the unit tests.
 */
"use strict";

const { execFile } = require("node:child_process");

const UA = { "User-Agent": "MMM-GlobeWeatherBridge/1.0 (MagicMirror fridge planner)" };

/** Split one `nmcli -t` line on unescaped colons, then unescape `\:` and `\\`. */
function splitTerse (line) {
	const fields = [];
	let cur = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && i + 1 < line.length) {
			cur += line[i + 1];
			i++;
		} else if (ch === ":") {
			fields.push(cur);
			cur = "";
		} else {
			cur += ch;
		}
	}
	fields.push(cur);
	return fields;
}

/** Parse `nmcli -t -f SSID,BSSID,SIGNAL device wifi list` output. */
function parseNmcliWifi (text) {
	const out = [];
	for (const line of String(text || "").split(/\r?\n/)) {
		if (!line.trim()) continue;
		const f = splitTerse(line);
		if (f.length < 3) continue;
		const signal = Number(f[f.length - 1]);
		const bssid = f[f.length - 2].toUpperCase();
		const ssid = f.slice(0, f.length - 2).join(":");
		if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(bssid) && Number.isFinite(signal)) out.push({ ssid, bssid, signal });
	}
	return out;
}

/** Google only locates universally administered MACs (bit 1 of the first octet clear). */
function isUniversalMac (mac) {
	const first = parseInt(mac.slice(0, 2), 16);
	if (Number.isNaN(first) || (first & 0x02) !== 0) return false;
	if (mac === "FF:FF:FF:FF:FF:FF" || mac.startsWith("00:00:5E")) return false;
	return true;
}

/** nmcli SIGNAL is 0..100 (percent); the API wants dBm. Common approximation. */
function percentToDbm (percent) {
	return Math.round(Math.max(0, Math.min(100, percent)) / 2 - 100);
}

/**
 * Access points to send: universally administered, not opted out with an
 * SSID ending in "_nomap", one entry per BSSID, strongest first, at most 20.
 */
function wifiAccessPoints (list) {
	const seen = new Map();
	for (const ap of list) {
		if (!isUniversalMac(ap.bssid)) continue;
		if (/_nomap$/i.test(ap.ssid)) continue;
		const prev = seen.get(ap.bssid);
		if (!prev || ap.signal > prev.signal) seen.set(ap.bssid, ap);
	}
	return [...seen.values()]
		.sort((a, b) => b.signal - a.signal)
		.slice(0, 20)
		.map((ap) => ({ macAddress: ap.bssid, signalStrength: percentToDbm(ap.signal) }));
}

function scanWifi () {
	return new Promise((resolve) => {
		execFile("nmcli", ["-t", "-f", "SSID,BSSID,SIGNAL", "device", "wifi", "list"], { timeout: 20000 }, (err, stdout) => {
			resolve(err ? [] : parseNmcliWifi(stdout));
		});
	});
}

async function googleWifiLocate (key, accessPoints) {
	const res = await fetch("https://www.googleapis.com/geolocation/v1/geolocate?key=" + encodeURIComponent(key), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ considerIp: false, wifiAccessPoints: accessPoints }),
		signal: AbortSignal.timeout(15000)
	});
	if (!res.ok) {
		// 404 = not enough known networks; 400/403 = key problem or Geolocation API not enabled.
		throw new Error("Google Geolocation HTTP " + res.status);
	}
	const body = await res.json();
	const lat = body && body.location && body.location.lat;
	const lng = body && body.location && body.location.lng;
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Google Geolocation gave no location");
	return { lat, lng, accuracy: Number(body.accuracy) || null };
}

async function googleReverse (key, lat, lng) {
	try {
		const url = "https://maps.googleapis.com/maps/api/geocode/json?latlng=" + lat + "," + lng + "&key=" + encodeURIComponent(key);
		const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
		if (!res.ok) return null;
		const body = await res.json();
		return body.status === "OK" && body.results[0] ? String(body.results[0].formatted_address) : null;
	} catch {
		return null;
	}
}

/** Free public IP lookups, tried in order. City level at best. */
const IP_SERVICES = [
	{ url: "https://ipapi.co/json/", map: (j) => (j.error ? null : { lat: Number(j.latitude), lng: Number(j.longitude), place: [j.city, j.region, j.country_name] }) },
	{ url: "https://ipwho.is/", map: (j) => (j.success === false ? null : { lat: Number(j.latitude), lng: Number(j.longitude), place: [j.city, j.region, j.country] }) },
	{ url: "https://get.geojs.io/v1/ip/geo.json", map: (j) => ({ lat: Number(j.latitude), lng: Number(j.longitude), place: [j.city, j.region, j.country] }) }
];

async function ipLocate () {
	for (const svc of IP_SERVICES) {
		try {
			const res = await fetch(svc.url, { headers: UA, signal: AbortSignal.timeout(10000) });
			if (!res.ok) continue;
			const r = svc.map(await res.json());
			if (r && Number.isFinite(r.lat) && Number.isFinite(r.lng) && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180) {
				return { lat: r.lat, lng: r.lng, address: r.place.filter(Boolean).join(", ") };
			}
		} catch {
			// try the next service
		}
	}
	throw new Error("no internet location service answered");
}

/**
 * Find the home location. Never throws; returns null when nothing worked.
 * @param {{googleKey?: string, log?: (msg: string) => void}} options
 */
async function locateHome ({ googleKey, log = () => {} } = {}) {
	if (googleKey) {
		const aps = wifiAccessPoints(await scanWifi());
		if (aps.length >= 2) {
			try {
				const fix = await googleWifiLocate(googleKey, aps);
				const address = await googleReverse(googleKey, fix.lat, fix.lng);
				return { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, source: "wifi", address };
			} catch (err) {
				log("Wi-Fi positioning failed (" + err.message + "), trying the internet lookup");
			}
		} else {
			log("Wi-Fi positioning skipped: " + aps.length + " usable Wi-Fi network(s) nearby, need 2");
		}
	}
	try {
		const ip = await ipLocate();
		return { lat: ip.lat, lng: ip.lng, accuracy: null, source: "internet", address: ip.address };
	} catch (err) {
		log("internet location lookup failed: " + err.message);
		return null;
	}
}

module.exports = { splitTerse, parseNmcliWifi, isUniversalMac, percentToDbm, wifiAccessPoints, locateHome };
