/* ESPN game summary -> the compact shape the details panel draws.
 * Source: https://site.api.espn.com/apis/site/v2/sports/<path>/summary?event=<id>
 * (public, no key, the same service MMM-MyScoreboard uses; unofficial).
 * Every section is optional: ESPN includes different parts per sport and per
 * game state, so missing data simply leaves that section out. */
"use strict";

const PATH_RE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9.-]*$/; // "football/nfl", "soccer/eng.1"; no "..".
const ID_RE = /^\d{1,12}$/;

// Team stats worth a line on the fridge, in this order, per sport (ESPN names).
const STAT_PICKS = {
	football: ["totalYards", "netPassingYards", "rushingYards", "firstDowns", "thirdDownEff", "turnovers", "totalPenaltiesYards", "possessionTime"],
	basketball: ["fieldGoalsMade-fieldGoalsAttempted", "threePointFieldGoalsMade-threePointFieldGoalsAttempted", "freeThrowsMade-freeThrowsAttempted", "totalRebounds", "assists", "turnovers", "steals", "blocks"],
	baseball: ["hits", "runs", "errors", "homeRuns", "strikeouts", "walks"],
	hockey: ["shotsTotal", "powerPlayGoals", "faceoffsWon", "hits", "blockedShots", "penaltyMinutes"],
	soccer: ["possessionPct", "totalShots", "shotsOnTarget", "wonCorners", "foulsCommitted", "yellowCards", "redCards", "offsides"]
};

const text = (v, max = 160) => (v === undefined || v === null ? "" : String(v).replace(/\s+/g, " ").trim().slice(0, max));

function sportOf (espnPath) {
	return String(espnPath || "").split("/")[0];
}

function teamsFromHeader (h) {
	const comp = (((h || {}).competitions) || [])[0] || {};
	const teams = (comp.competitors || []).map((c) => ({
		id: String((c.team || {}).id || ""),
		abbr: text((c.team || {}).abbreviation, 12),
		name: text((c.team || {}).displayName || (c.team || {}).name, 60),
		logo: (((c.team || {}).logos || [])[0] || {}).href || (c.team || {}).logo || "",
		score: c.score === undefined ? "" : text(c.score, 6),
		home: c.homeAway === "home",
		winner: c.winner === true,
		record: text((((c.record || [])[0]) || {}).summary || (((c.record || [])[0]) || {}).displayValue, 20)
	}));
	// away first, like a scoreboard
	teams.sort((a, b) => Number(a.home) - Number(b.home));
	const st = (comp.status || {}).type || {};
	return {
		teams,
		state: st.state || "pre", // pre | in | post
		status: text(st.shortDetail || st.detail || st.description, 40),
		date: comp.date || "",
		broadcast: text((((comp.broadcasts || [])[0] || {}).media || {}).shortName, 30)
	};
}

function parseSummary (body, espnPath) {
	const b = body || {};
	const sport = sportOf(espnPath);
	const head = teamsFromHeader(b.header);
	const byId = new Map(head.teams.map((t) => [t.id, t]));
	const abbrOf = (team) => (team && (team.abbreviation || (byId.get(String(team.id)) || {}).abbr)) || "";
	const out = { sport, ...head };

	const gi = b.gameInfo || {};
	out.venue = text((gi.venue || {}).fullName, 60);
	if (gi.weather && gi.weather.temperature !== undefined) {
		// conditionId is a word ("Sunny") for some games and a bare code ("7") for others.
		const cond = /[a-z]/i.test(String(gi.weather.conditionId || "")) ? " " + gi.weather.conditionId : "";
		out.weather = text(gi.weather.temperature + "°" + cond, 30);
	}

	// Win chance: last live value, else ESPN's pre-game projection.
	const wp = Array.isArray(b.winprobability) ? b.winprobability : [];
	const home = head.teams.find((t) => t.home);
	if (wp.length && typeof wp[wp.length - 1].homeWinPercentage === "number") {
		out.winChance = { home: Math.round(wp[wp.length - 1].homeWinPercentage * 100), live: true };
	} else if (b.predictor && b.predictor.homeTeam && b.predictor.homeTeam.gameProjection !== undefined) {
		out.winChance = { home: Math.round(Number(b.predictor.homeTeam.gameProjection)), live: false };
	}
	if (out.winChance && !Number.isFinite(out.winChance.home)) delete out.winChance;
	if (out.winChance) out.winChance.homeAbbr = home ? home.abbr : "";

	const line = (Array.isArray(b.pickcenter) && b.pickcenter[0]) || (Array.isArray(b.odds) && b.odds[0]) || null;
	if (line && (line.details || line.overUnder)) {
		out.odds = { line: text(line.details, 30), overUnder: line.overUnder !== undefined ? text(line.overUnder, 10) : "", provider: text((line.provider || {}).name, 30) };
	}

	// Team stats, one row per stat: away value, label, home value.
	const box = ((b.boxscore || {}).teams) || [];
	if (box.length === 2) {
		const side = (homeAway) => box.find((t) => t.homeAway === homeAway) || null;
		const awayT = side("away") || box[0];
		const homeT = side("home") || box[1];
		const statMap = (t) => new Map((t.statistics || []).map((s) => [s.name, s]));
		const a = statMap(awayT);
		const h = statMap(homeT);
		const picks = STAT_PICKS[sport] || [];
		const names = picks.filter((n) => a.has(n) && h.has(n));
		const use = names.length ? names : Array.from(a.keys()).filter((n) => h.has(n)).slice(0, 8);
		// Before a game ESPN fills this with season placeholders ("-", "0.0");
		// rows with nothing real on either side are left out.
		const empty = (v) => /^(|-|--|0|0\.0|0-0|0\.0%)$/.test(v);
		out.stats = use.map((n) => ({ label: text(a.get(n).label || a.get(n).displayName || n, 30), away: text(a.get(n).displayValue, 12), home: text(h.get(n).displayValue, 12) }))
			.filter((r) => !(empty(r.away) && empty(r.home)));
		if (!out.stats.length) delete out.stats;
	}

	// Leaders: per team, the first leader of each category.
	out.leaders = (Array.isArray(b.leaders) ? b.leaders : []).map((t) => ({
		team: abbrOf(t.team),
		items: (t.leaders || []).map((cat) => {
			const top = (cat.leaders || [])[0];
			return top && top.athlete ? { category: text(cat.displayName, 30), name: text(top.athlete.shortName || top.athlete.displayName, 40), value: text(top.displayValue, 40) } : null;
		}).filter(Boolean).slice(0, 5)
	})).filter((t) => t.items.length);

	// Scoring: football/basketball/hockey list scoringPlays; soccer lists goals in keyEvents.
	if (Array.isArray(b.scoringPlays) && b.scoringPlays.length) {
		out.scoring = b.scoringPlays.map((p) => ({
			when: [p.period && p.period.number ? "Q" + p.period.number : "", (p.clock || {}).displayValue || ""].filter(Boolean).join(" "),
			team: abbrOf(p.team),
			text: text(p.text, 140),
			score: p.awayScore !== undefined ? p.awayScore + "–" + p.homeScore : ""
		}));
	} else if (Array.isArray(b.keyEvents)) {
		out.scoring = b.keyEvents.filter((k) => /goal/i.test(((k.type || {}).text) || "") && !/disallowed/i.test(((k.type || {}).text) || "")).map((k) => ({
			when: text((k.clock || {}).displayValue, 10),
			team: abbrOf(k.team),
			text: text(k.text || k.shortText, 140),
			score: ""
		}));
	}
	if (sport === "hockey" && out.scoring) for (const s of out.scoring) s.when = s.when.replace(/^Q/, "P");

	out.injuries = (Array.isArray(b.injuries) ? b.injuries : []).map((t) => ({
		team: abbrOf(t.team),
		items: (t.injuries || []).map((i) => ({ name: text((i.athlete || {}).displayName, 40), status: text(i.status, 20), detail: text(((i.details || {}).type) || "", 30) })).filter((i) => i.name).slice(0, 12)
	})).filter((t) => t.items.length);

	// Lineups (soccer): starters with shirt number and position.
	out.lineups = (Array.isArray(b.rosters) ? b.rosters : []).map((r) => ({
		team: abbrOf(r.team),
		formation: text(r.formation, 12),
		starters: (r.roster || []).filter((p) => p.starter).map((p) => ({ number: text(p.jersey, 4), name: text((p.athlete || {}).displayName, 40), pos: text((p.position || {}).abbreviation, 6) }))
	})).filter((r) => r.starters.length);

	// Standings: the table(s) that contain either team.
	const teamIds = new Set(head.teams.map((t) => t.id));
	out.standings = ((((b.standings || {}).groups) || [])).map((g) => {
		const entries = (((g.standings || {}).entries) || []);
		if (!entries.some((e) => teamIds.has(String(e.id)))) return null;
		const stat = (e, ...names) => {
			for (const n of names) {
				const s = (e.stats || []).find((x) => x.name === n || x.type === n);
				if (s) return text(s.displayValue, 10);
			}
			return "";
		};
		return {
			title: text(g.header, 60),
			rows: entries.map((e) => ({
				team: text(e.team, 40),
				mine: teamIds.has(String(e.id)),
				record: stat(e, "overall") || [stat(e, "wins"), stat(e, "losses"), stat(e, "ties")].filter((x) => x !== "").join("-"),
				points: stat(e, "points")
			})).slice(0, 24)
		};
	}).filter(Boolean);

	out.news = ((((b.news || {}).articles) || [])).map((a) => ({ headline: text(a.headline, 160), published: a.published || "" })).filter((a) => a.headline).slice(0, 6);
	return out;
}

module.exports = { PATH_RE, ID_RE, parseSummary, sportOf };
