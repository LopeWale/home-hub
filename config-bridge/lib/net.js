"use strict";

const os = require("node:os");
const net = require("node:net");
const { execFile } = require("node:child_process");

function normalizeIp (address) {
	if (typeof address !== "string") return "";
	// IPv4 mapped IPv6, e.g. ::ffff:100.101.102.103
	if (address.startsWith("::ffff:") && net.isIPv4(address.slice(7))) return address.slice(7);
	return address;
}

function ipv4ToInt (ip) {
	return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr4 (ip, base, bits) {
	if (!net.isIPv4(ip)) return false;
	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
	return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** Tailscale uses 100.64.0.0/10 (CGNAT) for IPv4 and fd7a:115c:a1e0::/48 for IPv6. */
function isTailscaleAddress (address) {
	const ip = normalizeIp(address);
	if (net.isIPv4(ip)) return inCidr4(ip, "100.64.0.0", 10);
	if (net.isIPv6(ip)) return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
	return false;
}

function isLoopback (address) {
	const ip = normalizeIp(address);
	return ip === "::1" || inCidr4(ip, "127.0.0.0", 8);
}

/** Find this machine's Tailscale IPv4. Prefers the tailscale0 interface. */
function findTailscaleIPv4 () {
	const interfaces = os.networkInterfaces();
	const preferred = interfaces.tailscale0 || [];
	for (const entry of preferred) {
		if (entry.family === "IPv4" && isTailscaleAddress(entry.address)) return entry.address;
	}
	for (const name of Object.keys(interfaces)) {
		for (const entry of interfaces[name] || []) {
			if (entry.family === "IPv4" && isTailscaleAddress(entry.address)) return entry.address;
		}
	}
	return null;
}

function addressStillPresent (address) {
	const interfaces = os.networkInterfaces();
	return Object.values(interfaces).some((list) => (list || []).some((entry) => entry.address === address));
}

/**
 * Ask tailscaled who owns a peer address. Requires the `tailscale` CLI.
 * @returns {Promise<string|null>} login name, e.g. "someone@example.com"
 */
function tailscaleWhois (address) {
	return new Promise((resolve) => {
		execFile("tailscale", ["whois", "--json", normalizeIp(address)], { timeout: 5000 }, (err, stdout) => {
			if (err) return resolve(null);
			try {
				const info = JSON.parse(stdout);
				resolve(info && info.UserProfile && info.UserProfile.LoginName ? info.UserProfile.LoginName : null);
			} catch {
				resolve(null);
			}
		});
	});
}

module.exports = { normalizeIp, inCidr4, isTailscaleAddress, isLoopback, findTailscaleIPv4, addressStillPresent, tailscaleWhois };
