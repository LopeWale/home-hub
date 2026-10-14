"use strict";

/*
 * Team lists for the admin page's team picker. MMM-MyScoreboard matches
 * teams by ESPN's exact abbreviation (Oklahoma = OU, Duke = DUKE), so the
 * picker offers ESPN's own list for the chosen league.
 * League -> ESPN path comes from lib/espn-leagues.json, generated from the
 * pinned module source. Leagues served by other providers (CFL, PWHL, CPL,
 * the all-soccer feeds) return supported: false and the page falls back to
 * typing codes.
 */

const path = require("node:path");
const fs = require("node:fs");

const LEAGUES = JSON.parse(fs.readFileSync(path.join(__dirname, "espn-leagues.json"), "utf-8")).leagues;
const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // league -> { at, teams }

/** ESPN /teams response -> [{ abbr, name }] sorted by name, duplicates kept (ESPN reuses some codes). */
function parseTeams (body) {
	const leagues = (((body || {}).sports || [])[0] || {}).leagues || [];
	const list = ((leagues[0] || {}).teams || []).map((t) => t.team || {}).filter((t) => t.abbreviation && (t.displayName || t.name));
	return list
		.map((t) => ({ abbr: String(t.abbreviation).slice(0, 12), name: String(t.displayName || t.name).slice(0, 80) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

async function teamsFor (league, fetchImpl = fetch) {
	const espnPath = Object.prototype.hasOwnProperty.call(LEAGUES, league) ? LEAGUES[league] : null;
	if (!espnPath) return { supported: false, teams: [] };
	const hit = cache.get(league);
	if (hit && Date.now() - hit.at < TTL_MS) return { supported: true, teams: hit.teams };
	const url = "https://site.api.espn.com/apis/site/v2/sports/" + espnPath + "/teams?limit=1000";
	const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error("ESPN answered HTTP " + res.status);
	const teams = parseTeams(await res.json());
	cache.set(league, { at: Date.now(), teams });
	return { supported: true, teams };
}

module.exports = { LEAGUES, parseTeams, teamsFor };
