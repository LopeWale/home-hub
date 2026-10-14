/* Wi-Fi join string for QR codes (the "WIFI:" format phones understand).
 * Kept separate from node_helper.js so tests can load it without MagicMirror. */
"use strict";

/** Backslash escape the characters the WIFI: format reserves: \ ; , : " */
function escapeWifi (value) {
	return String(value).replace(/([\\;,:"])/g, "\\$1");
}

/** config.js leaves "${GUEST_WIFI_SSID}" as literal text when config.env does not set it. */
function unsetValue (value) {
	return value === undefined || value === null || String(value).trim() === "" || String(value).includes("${");
}

/**
 * @param {{ssid: string, password?: string, security?: string, hidden?: boolean}} net
 * @returns {string|null} null when there is no usable SSID
 */
function wifiString (net) {
	if (!net || unsetValue(net.ssid)) return null;
	const security = ["WPA", "WEP", "nopass"].includes(net.security) ? net.security : "WPA";
	const password = unsetValue(net.password) ? "" : String(net.password);
	const type = security !== "nopass" && password === "" ? "nopass" : security;
	let out = "WIFI:T:" + type + ";S:" + escapeWifi(net.ssid) + ";";
	if (type !== "nopass") out += "P:" + escapeWifi(password) + ";";
	if (net.hidden) out += "H:true;";
	return out + ";";
}

module.exports = { escapeWifi, unsetValue, wifiString };
