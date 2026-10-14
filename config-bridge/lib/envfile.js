"use strict";

/*
 * Edits MagicMirror's config/config.env without disturbing hand written
 * lines. The bridge only ever adds, changes or removes keys that start with
 * MANAGED_PREFIX. Reading uses util.parseEnv, the same parser Node's
 * process.loadEnvFile uses (which is what MagicMirror calls).
 */

const util = require("node:util");

const MANAGED_PREFIX = "SECRET_BRIDGE_";
const KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function parse (text) {
	return util.parseEnv(text || "");
}

/** Quote a value so util.parseEnv returns it unchanged, or throw. */
function quote (value) {
	if (typeof value !== "string") throw new Error("secret value must be a string");
	if (/[\r\n]/.test(value)) throw new Error("secret value must not contain line breaks");
	let line;
	if (!value.includes("'")) line = "'" + value + "'";
	else if (!value.includes("\"") && !value.includes("\\")) line = "\"" + value + "\"";
	else throw new Error("secret value contains characters that cannot be stored safely");
	const roundTrip = parse("X=" + line).X;
	if (roundTrip !== value) throw new Error("secret value does not survive config.env round trip");
	return line;
}

/**
 * Return new env file text with managed keys set to `managed` exactly:
 * keys in `managed` are written, other MANAGED_PREFIX keys are removed,
 * every non managed line is preserved verbatim.
 * @param {string} text current config.env text
 * @param {Object<string,string>} managed SECRET_BRIDGE_* name -> value
 */
function updateManaged (text, managed) {
	for (const name of Object.keys(managed)) {
		if (!name.startsWith(MANAGED_PREFIX)) throw new Error("refusing to write unmanaged key " + name);
	}
	const remaining = new Map(Object.entries(managed));
	const out = [];
	for (const line of (text || "").split(/\r?\n/)) {
		const match = KEY_RE.exec(line);
		if (match && match[1].startsWith(MANAGED_PREFIX)) {
			const name = match[1];
			if (remaining.has(name)) {
				out.push(name + "=" + quote(remaining.get(name)));
				remaining.delete(name);
			}
			// else: managed key no longer referenced, drop it
			continue;
		}
		out.push(line);
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	if (remaining.size > 0) {
		if (!out.some((line) => line.includes("managed by mm-configbridge"))) {
			out.push("", "# Keys below are managed by mm-configbridge. Do not edit by hand.");
		}
		for (const [name, value] of remaining) out.push(name + "=" + quote(value));
	}
	return out.join("\n") + "\n";
}

module.exports = { MANAGED_PREFIX, parse, quote, updateManaged };
