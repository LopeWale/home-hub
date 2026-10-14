/* mm-bridge-merge.js
 *
 * Shared by config/config.js (runs inside MagicMirror) and the config
 * bridge service (config-bridge/). Keep it dependency free.
 *
 * config.bridge.json shape:
 *   { "MMM-MyGCalendar": { "calendars": [...] }, "MMM-MyScoreboard": {...} }
 *
 * Rules
 * - Only the `config` object of a module entry is touched. Position, page
 *   membership and module names stay owned by config.js.
 * - Objects merge recursively. Arrays and scalars replace.
 * - Secret values are stored as "**SECRET_NAME**" placeholders. The real
 *   values live in config/config.env, which MagicMirror loads into
 *   process.env and never serves over HTTP.
 * - In the server side ("full") pass, placeholders are resolved from
 *   process.env. In the browser ("redacted") pass they stay as
 *   placeholders and MagicMirror's NodeHelper restores them inside socket
 *   payloads (js/node_helper.js, getAllowedSecrets).
 */
"use strict";

const fs = require("node:fs");

const PLACEHOLDER_RE = /^\*\*(SECRET_[A-Z0-9_]+)\*\*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject (value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone (value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepMerge (base, override) {
	if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);
	const out = Object.assign({}, base);
	for (const key of Object.keys(override)) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		const value = override[key];
		out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : clone(value);
	}
	return out;
}

function placeholderName (value) {
	if (typeof value !== "string") return null;
	const match = PLACEHOLDER_RE.exec(value);
	return match ? match[1] : null;
}

function makePlaceholder (name) {
	return "**" + name + "**";
}

/** Replace "**SECRET_X**" strings with env values (only when the env value exists). */
function resolveSecrets (value, env) {
	if (Array.isArray(value)) return value.map((item) => resolveSecrets(item, env));
	if (isPlainObject(value)) {
		const out = {};
		for (const key of Object.keys(value)) out[key] = resolveSecrets(value[key], env);
		return out;
	}
	const name = placeholderName(value);
	if (name && typeof env[name] === "string" && env[name] !== "") return env[name];
	return value;
}

/** Collect every SECRET_ name referenced by placeholders inside a value. */
function collectSecretNames (value, found = new Set()) {
	if (Array.isArray(value)) value.forEach((item) => collectSecretNames(item, found));
	else if (isPlainObject(value)) Object.keys(value).forEach((key) => collectSecretNames(value[key], found));
	else {
		const name = placeholderName(value);
		if (name) found.add(name);
	}
	return found;
}

function readBridgeFile (file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (err) {
		if (err.code === "ENOENT") return {};
		throw err;
	}
	if (text.trim() === "") return {};
	const data = JSON.parse(text);
	if (!isPlainObject(data)) throw new Error("config.bridge.json must contain a JSON object");
	return data;
}

/**
 * Apply bridge overrides to a MagicMirror config object in place.
 * @param {object} config MagicMirror config (with a modules array)
 * @param {object} overrides parsed config.bridge.json
 * @param {object} [options]
 * @param {boolean} [options.resolve] resolve secret placeholders from env
 * @param {object} [options.env] environment to resolve from (default process.env)
 * @returns {string[]} module names that received overrides
 */
function applyBridgeOverrides (config, overrides, options = {}) {
	const env = options.env || process.env;
	const applied = [];
	if (!config || !Array.isArray(config.modules) || !isPlainObject(overrides)) return applied;
	for (const entry of config.modules) {
		if (!entry || typeof entry.module !== "string") continue;
		const override = overrides[entry.module];
		if (!isPlainObject(override)) continue;
		const value = options.resolve ? resolveSecrets(override, env) : override;
		entry.config = deepMerge(isPlainObject(entry.config) ? entry.config : {}, value);
		applied.push(entry.module);
	}
	return applied;
}

/** Convenience wrapper used by config.js. Never throws. */
function applyBridgeFile (config, file, options = {}) {
	try {
		const overrides = readBridgeFile(file);
		return applyBridgeOverrides(config, overrides, options);
	} catch (err) {
		console.error("[config.bridge] overrides not applied (" + file + "): " + err.message);
		return [];
	}
}

module.exports = {
	isPlainObject,
	deepMerge,
	placeholderName,
	makePlaceholder,
	resolveSecrets,
	collectSecretNames,
	readBridgeFile,
	applyBridgeOverrides,
	applyBridgeFile
};
