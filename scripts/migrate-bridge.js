#!/usr/bin/env node
/* One time moves inside config.bridge.json when modules are replaced.
 *   MMM-WiFiPassword {network, password, authType, showPassword}
 *     -> MMM-GuestNet {ssid, password, security, showPassword}
 *   MMM-MyScoreboard: a CFL (Canadian Football League) entry that holds only
 *     non-CFL codes (college teams such as OSU, OU, Duke) becomes NCAAF with
 *     ESPN's uppercase codes.
 * The old entry is left in place (MagicMirror ignores entries for modules it
 * does not load), so going back to an older version keeps working.
 * Usage: node scripts/migrate-bridge.js ~/MagicMirror/config/config.bridge.json
 */
"use strict";

const fs = require("node:fs");

function migrate (data) {
	const changes = [];
	const old = data["MMM-WiFiPassword"];
	if (old && typeof old === "object" && !data["MMM-GuestNet"]) {
		const next = {};
		if (typeof old.network === "string") next.ssid = old.network;
		if (typeof old.password === "string") next.password = old.password;
		if (["WPA", "WEP", "nopass"].includes(old.authType)) next.security = old.authType;
		if (typeof old.showPassword === "boolean") next.showPassword = old.showPassword;
		if (Object.keys(next).length) {
			data["MMM-GuestNet"] = next;
			changes.push("guest Wi-Fi settings copied from MMM-WiFiPassword to MMM-GuestNet");
		}
	}
	const sb = data["MMM-MyScoreboard"];
	if (sb && Array.isArray(sb.sports)) {
		const CFL_CODES = new Set(["BC", "CGY", "EDM", "SSK", "SASK", "WPG", "HAM", "TOR", "OTT", "MTL"]);
		const kept = [];
		for (const entry of sb.sports) {
			const teams = entry && Array.isArray(entry.teams) ? entry.teams.map((t) => String(t).trim().toUpperCase()).filter(Boolean) : [];
			if (entry && entry.league === "CFL" && teams.length && teams.every((t) => !CFL_CODES.has(t))) {
				const ncaaf = kept.find((e) => e.league === "NCAAF") || sb.sports.find((e) => e !== entry && e && e.league === "NCAAF");
				if (ncaaf) {
					ncaaf.teams = Array.from(new Set([...(ncaaf.teams || []), ...teams]));
				} else {
					kept.push(Object.assign({}, entry, { league: "NCAAF", teams }));
				}
				changes.push("sports: CFL teams " + teams.join(", ") + " moved to NCAAF (college football)");
				continue;
			}
			kept.push(entry);
		}
		sb.sports = kept;
	}
	return changes;
}

if (require.main === module) {
	const file = process.argv[2];
	let text;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (err) {
		if (err.code === "ENOENT") process.exit(0);
		throw err;
	}
	let data;
	try {
		data = JSON.parse(text);
	} catch (err) {
		console.warn("    config.bridge.json is not valid JSON, not migrated: " + err.message);
		process.exit(0);
	}
	const changes = migrate(data);
	if (changes.length) {
		const tmp = file + ".migrate.tmp";
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o644 });
		fs.renameSync(tmp, file);
		for (const c of changes) console.log("    " + c);
	}
}

module.exports = { migrate };
