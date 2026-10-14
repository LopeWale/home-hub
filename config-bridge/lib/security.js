"use strict";

const crypto = require("node:crypto");

function digest (value) {
	return crypto.createHash("sha256").update(String(value)).digest();
}

/** Constant time string compare (hashing first equalises lengths). */
function safeEqual (a, b) {
	return crypto.timingSafeEqual(digest(a), digest(b));
}

/**
 * Token from "X-Bridge-Token: <token>" (used by the admin page, so it can
 * coexist with browser basic auth in the Authorization header) or from
 * "Authorization: Bearer <token>" (curl and scripts).
 */
function checkBearer (req, token) {
	const custom = req.headers["x-bridge-token"];
	if (typeof custom === "string" && custom.length > 0) return safeEqual(custom.trim(), token);
	const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
	return Boolean(match) && safeEqual(match[1].trim(), token);
}

/** Optional second layer: HTTP basic auth on every request, including the page itself. */
function checkBasic (req, user, pass) {
	const header = req.headers.authorization || "";
	const match = /^Basic\s+(.+)$/i.exec(header);
	if (!match) return false;
	const decoded = Buffer.from(match[1], "base64").toString("utf-8");
	const idx = decoded.indexOf(":");
	if (idx < 0) return false;
	// Evaluate both compares to keep timing flat.
	const userOk = safeEqual(decoded.slice(0, idx), user);
	const passOk = safeEqual(decoded.slice(idx + 1), pass);
	return userOk && passOk;
}

/**
 * Per IP fixed window limiter plus a lockout after repeated auth failures.
 */
class RateLimiter {
	constructor ({ perMinute = 120, authFailures = 10, lockMinutes = 15 } = {}) {
		this.perMinute = perMinute;
		this.authFailures = authFailures;
		this.lockMs = lockMinutes * 60 * 1000;
		this.windows = new Map();
		this.failures = new Map();
	}

	allow (ip) {
		const now = Date.now();
		const fail = this.failures.get(ip);
		if (fail && fail.lockedUntil > now) return { ok: false, reason: "locked" };
		const win = this.windows.get(ip);
		if (!win || now - win.start >= 60000) {
			this.windows.set(ip, { start: now, count: 1 });
			return { ok: true };
		}
		win.count += 1;
		return win.count <= this.perMinute ? { ok: true } : { ok: false, reason: "rate" };
	}

	recordAuthFailure (ip) {
		const now = Date.now();
		const fail = this.failures.get(ip) || { count: 0, first: now, lockedUntil: 0 };
		if (now - fail.first > this.lockMs) {
			fail.count = 0;
			fail.first = now;
		}
		fail.count += 1;
		if (fail.count >= this.authFailures) fail.lockedUntil = now + this.lockMs;
		this.failures.set(ip, fail);
	}

	recordAuthSuccess (ip) {
		this.failures.delete(ip);
	}
}

/** Remove anything that looks like a URL so secrets never reach logs or the browser. */
function redactUrls (text) {
	return String(text).replace(/\b(?:https?|webcal|wss?):\/\/[^\s"'<>]+/gi, "[url redacted]");
}

module.exports = { safeEqual, checkBearer, checkBasic, RateLimiter, redactUrls };
