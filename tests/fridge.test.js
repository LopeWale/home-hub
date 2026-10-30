/* Unit tests for the guest Wi-Fi QR string, the bridge migration, Bluetooth
 * parsing, the sports team picker and game panel, the todo tabs and the weather
 * line (no network).
 * Run: node --test tests/fridge.test.js */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { wifiString } = require("../modules/MMM-GuestNet/wifiqr");
const { migrate } = require("../scripts/migrate-bridge");

test("wifiString escapes reserved characters and handles open networks", () => {
	assert.equal(wifiString({ ssid: "Guest;1", password: "p:a\\ss,\"x", security: "WPA" }), "WIFI:T:WPA;S:Guest\\;1;P:p\\:a\\\\ss\\,\\\"x;;");
	assert.equal(wifiString({ ssid: "Cafe", password: "", security: "WPA" }), "WIFI:T:nopass;S:Cafe;;");
	assert.equal(wifiString({ ssid: "Hidden", password: "secret12", hidden: true }), "WIFI:T:WPA;S:Hidden;P:secret12;H:true;;");
	assert.equal(wifiString({ ssid: "${GUEST_WIFI_SSID}", password: "x" }), null, "unset config.env placeholder");
	assert.equal(wifiString({ ssid: "" }), null);
});

test("migrate copies guest Wi-Fi settings once and keeps the old entry", () => {
	const data = { "MMM-WiFiPassword": { network: "Guests", password: "pw123456", authType: "WPA", showPassword: false, qrSize: 260 } };
	assert.equal(migrate(data).length, 1);
	assert.deepEqual(data["MMM-GuestNet"], { ssid: "Guests", password: "pw123456", security: "WPA", showPassword: false });
	assert.ok(data["MMM-WiFiPassword"]);
	assert.equal(migrate(data).length, 0, "second run changes nothing");
	assert.equal(migrate({}).length, 0);
});

const bt = require("../modules/MMM-BluetoothAudio/bt");

test("bluetoothctl output: device lists, info and controller state", () => {
	const devices = bt.parseDevices("\u001b[0;94m[bluetooth]\u001b[0m# \nDevice 41:42:1A:2B:3C:4D JBL Flip 5\nDevice 7c:a1:b2:c3:d4:e5 Kitchen TV\nController 11:22:33:44:55:66 fridge [default]\njunk\n");
	assert.deepEqual(devices, [{ mac: "41:42:1A:2B:3C:4D", name: "JBL Flip 5" }, { mac: "7C:A1:B2:C3:D4:E5", name: "Kitchen TV" }]);
	const info = bt.parseInfo([
		"Device 41:42:1A:2B:3C:4D (public)",
		"\tName: JBL Flip 5",
		"\tAlias: JBL Flip 5",
		"\tClass: 0x00240414",
		"\tIcon: audio-card",
		"\tPaired: yes",
		"\tTrusted: yes",
		"\tConnected: no",
		"\tUUID: Audio Sink                (0000110b-0000-1000-8000-00805f9b34fb)"
	].join("\n"));
	assert.equal(info.name, "JBL Flip 5");
	assert.equal(info.paired, true);
	assert.equal(info.connected, false);
	assert.equal(info.audio, true);
	assert.equal(bt.parseInfo("\tName: Phone\n\tIcon: phone\n\tPaired: no").audio, false);
	assert.deepEqual(bt.parseShow("Controller 11:22:33:44:55:66 (public)\n\tPowered: yes\n"), { present: true, powered: true });
	assert.deepEqual(bt.parseShow("No default controller available"), { present: false, powered: false });
	assert.equal(bt.isMac("41:42:1a:2b:3c:4d"), true);
	assert.equal(bt.isMac("41:42:1A:2B:3C:4D; rm -rf /"), false);
});

test("pw-dump: finds the Bluetooth sink and the default output", () => {
	const dump = JSON.stringify([
		{ id: 59, type: "PipeWire:Interface:Node", info: { props: { "media.class": "Audio/Sink", "node.name": "alsa_output.platform-bcm2835_audio.stereo-fallback", "node.description": "Built-in Audio Stereo" } } },
		{ id: 89, type: "PipeWire:Interface:Node", info: { props: { "media.class": "Audio/Sink", "node.name": "alsa_output.platform-fef00700.hdmi.hdmi-stereo", "node.description": "Built-in Audio Digital Stereo (HDMI)" } } },
		{ id: 120, type: "PipeWire:Interface:Node", info: { props: { "media.class": "Audio/Sink", "node.name": "bluez_output.41_42_1A_2B_3C_4D.1", "node.description": "JBL Flip 5", "api.bluez5.address": "41:42:1A:2B:3C:4D" } } },
		{ id: 30, type: "PipeWire:Interface:Metadata", props: { "metadata.name": "default" }, metadata: [{ subject: 0, key: "default.audio.sink", type: "Spa:String:JSON", value: { name: "bluez_output.41_42_1A_2B_3C_4D.1" } }] }
	]);
	const { sinks, defaultName } = bt.parsePwDump(dump);
	assert.equal(sinks.length, 3);
	assert.equal(sinks.find((s) => s.btAddress === "41:42:1A:2B:3C:4D").id, 120);
	assert.equal(defaultName, "bluez_output.41_42_1A_2B_3C_4D.1");
	assert.equal(bt.outputLabel(sinks[0]), "Aux jack");
	assert.equal(bt.outputLabel(sinks[1]), "Screen (HDMI)");
	assert.equal(bt.outputLabel(sinks[2]), "JBL Flip 5");
	assert.deepEqual(bt.parsePwDump("not json"), { sinks: [], defaultName: null });
});

test("migrate moves college teams filed under CFL to NCAAF", () => {
	const data = { "MMM-MyScoreboard": { sports: [{ league: "NFL", teams: ["BAL"] }, { league: "CFL", teams: ["OSU", "OU", "Duke"] }, { league: "CFL", teams: ["TOR"] }] } };
	assert.equal(migrate(data).length, 1);
	assert.deepEqual(data["MMM-MyScoreboard"].sports, [{ league: "NFL", teams: ["BAL"] }, { league: "NCAAF", teams: ["OSU", "OU", "DUKE"] }, { league: "CFL", teams: ["TOR"] }]);
	assert.equal(migrate(data).length, 0, "second run changes nothing");
	const merged = { "MMM-MyScoreboard": { sports: [{ league: "NCAAF", teams: ["OU"] }, { league: "CFL", teams: ["Duke", "OU"] }] } };
	migrate(merged);
	assert.deepEqual(merged["MMM-MyScoreboard"].sports, [{ league: "NCAAF", teams: ["OU", "DUKE"] }]);
});

test("team picker parses ESPN team lists", () => {
	const { parseTeams, LEAGUES } = require("../config-bridge/lib/teams");
	const body = { sports: [{ leagues: [{ teams: [{ team: { abbreviation: "OU", displayName: "Oklahoma Sooners" } }, { team: { abbreviation: "DUKE", displayName: "Duke Blue Devils" } }, { team: { displayName: "No code" } }] }] }] };
	assert.deepEqual(parseTeams(body), [{ abbr: "DUKE", name: "Duke Blue Devils" }, { abbr: "OU", name: "Oklahoma Sooners" }]);
	assert.deepEqual(parseTeams({}), []);
	assert.equal(LEAGUES.NCAAF, "football/college-football");
	assert.equal(LEAGUES.CFL, undefined, "CFL comes from Sportsnet, not ESPN");
});

test("ESPN game summary parsing for the sports panel", () => {
	const { parseSummary, PATH_RE, ID_RE } = require("../modules/MMM-GameDetails/espn");
	const body = {
		header: { competitions: [{ date: "2026-10-04T20:25Z", status: { type: { state: "in", shortDetail: "7:11 - 4th" } }, broadcasts: [{ media: { shortName: "CBS" } }],
			competitors: [
				{ homeAway: "home", score: "16", team: { id: "13", abbreviation: "LV", displayName: "Las Vegas Raiders" }, record: [{ summary: "3-0" }] },
				{ homeAway: "away", score: "17", team: { id: "12", abbreviation: "KC", displayName: "Kansas City Chiefs" }, record: [{ summary: "3-0" }] }] }] },
		gameInfo: { venue: { fullName: "Allegiant Stadium" }, weather: { temperature: 96, conditionId: "Sunny" } },
		winprobability: [{ homeWinPercentage: 0.4 }, { homeWinPercentage: 0.5444 }],
		pickcenter: [{ provider: { name: "DraftKings" }, details: "KC -3.5", overUnder: 47.5 }],
		boxscore: { teams: [
			{ homeAway: "away", team: { id: "12" }, statistics: [{ name: "totalYards", label: "Total Yards", displayValue: "314" }, { name: "turnovers", label: "Turnovers", displayValue: "0" }] },
			{ homeAway: "home", team: { id: "13" }, statistics: [{ name: "totalYards", label: "Total Yards", displayValue: "334" }, { name: "turnovers", label: "Turnovers", displayValue: "1" }] }] },
		leaders: [{ team: { id: "12", abbreviation: "KC" }, leaders: [{ displayName: "Passing Yards", leaders: [{ displayValue: "14/28, 170 YDS", athlete: { shortName: "P. Mahomes" } }] }] }],
		scoringPlays: [{ text: "Ian Thomas 27 Yd pass", awayScore: 0, homeScore: 7, period: { number: 1 }, clock: { displayValue: "8:10" }, team: { id: "13", abbreviation: "LV" } }],
		injuries: [{ team: { id: "13", abbreviation: "LV" }, injuries: [{ status: "Questionable", athlete: { displayName: "Jalen Nailor" }, details: { type: "Concussion" } }] }],
		standings: { groups: [{ header: "AFC West", standings: { entries: [{ team: "Kansas City", id: "12", stats: [{ name: "wins", displayValue: "3" }, { name: "losses", displayValue: "0" }] }, { team: "Denver", id: "7", stats: [{ name: "wins", displayValue: "2" }, { name: "losses", displayValue: "1" }] }] } }] },
		news: { articles: [{ headline: "Week 4 takeaways" }] }
	};
	const d = parseSummary(body, "football/nfl");
	assert.deepEqual(d.teams.map((t) => t.abbr + ":" + t.score + (t.home ? "h" : "")), ["KC:17", "LV:16h"], "away first");
	assert.equal(d.state, "in");
	assert.deepEqual(d.winChance, { home: 54, live: true, homeAbbr: "LV" });
	assert.deepEqual(d.odds, { line: "KC -3.5", overUnder: "47.5", provider: "DraftKings" });
	assert.equal(d.weather, "96\u00B0 Sunny");
	assert.deepEqual(d.stats, [{ label: "Total Yards", away: "314", home: "334" }, { label: "Turnovers", away: "0", home: "1" }]);
	assert.deepEqual(d.leaders, [{ team: "KC", items: [{ category: "Passing Yards", name: "P. Mahomes", value: "14/28, 170 YDS" }] }]);
	assert.deepEqual(d.scoring, [{ when: "Q1 8:10", team: "LV", text: "Ian Thomas 27 Yd pass", score: "0\u20137" }]);
	assert.deepEqual(d.injuries, [{ team: "LV", items: [{ name: "Jalen Nailor", status: "Questionable", detail: "Concussion" }] }]);
	assert.deepEqual(d.standings[0].rows, [{ team: "Kansas City", mine: true, record: "3-0", points: "" }, { team: "Denver", mine: false, record: "2-1", points: "" }]);
	assert.equal(d.news.length, 1);
	const soccer = parseSummary({ header: body.header, rosters: [{ team: { id: "12", abbreviation: "ARS" }, formation: "4-3-3", roster: [{ starter: true, jersey: "1", athlete: { displayName: "David Raya" }, position: { abbreviation: "G" } }, { starter: false, athlete: { displayName: "Sub" } }] }],
		keyEvents: [{ type: { text: "Goal" }, clock: { displayValue: "23'" }, team: { id: "12" }, text: "Saka scores" }, { type: { text: "Yellow Card" } }] }, "soccer/eng.1");
	assert.deepEqual(soccer.lineups, [{ team: "ARS", formation: "4-3-3", starters: [{ number: "1", name: "David Raya", pos: "G" }] }]);
	assert.deepEqual(soccer.scoring, [{ when: "23'", team: "KC", text: "Saka scores", score: "" }]);
	assert.ok(PATH_RE.test("football/nfl") && PATH_RE.test("soccer/eng.1") && !PATH_RE.test("../etc"));
	assert.ok(ID_RE.test("401872976") && !ID_RE.test("1;rm"));
});

test("Bluetooth: BlueZ address-names are not real names", () => {
	assert.equal(bt.isRealName("42-C9-41-BC-2A-8D"), false);
	assert.equal(bt.isRealName("42:C9:41:BC:2A:8D"), false);
	assert.equal(bt.isRealName(""), false);
	assert.equal(bt.isRealName("JBL Flip 5"), true);
	assert.equal(bt.isRealName("Bose SoundLink Micro"), true);
});

test("todo tabs: a tab renamed in place carries its tasks (code taken from the shipped patch)", () => {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	// Rebuild tabs.js from the new-file hunk of patches/MMM-TodoList.patch.
	const patch = fs.readFileSync(path.join(__dirname, "..", "patches", "MMM-TodoList.patch"), "utf-8");
	const hunk = patch.split("diff --git a/tabs.js b/tabs.js")[1].split(/\ndiff --git /)[0];
	const code = hunk.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-"));
	fs.writeFileSync(path.join(dir, "tabs.js"), code);
	const { renamesBetween, applyRenames } = require(path.join(dir, "tabs.js"));

	assert.deepEqual(renamesBetween(["Shopping", "Family", "Me"], ["Shopping", "Ada", "Me"]), [["Family", "Ada"]]);
	assert.deepEqual(renamesBetween(["A", "B"], ["A", "B", "C"]), [], "added tab is not a rename");
	assert.deepEqual(renamesBetween(["A", "B"], ["B", "A"]), [], "reordering is not a rename");
	assert.deepEqual(renamesBetween(null, ["A"]), []);

	fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify({ Shopping: [{ text: "Milk", done: false }], Family: [{ text: "Call mom", done: false }] }));
	applyRenames(dir, ["Shopping", "Family", "Me"]); // first run only remembers the tabs
	applyRenames(dir, ["Shopping", "Ada", "Me"]);
	const tasks = JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf-8"));
	assert.deepEqual(Object.keys(tasks).sort(), ["Ada", "Shopping"]);
	assert.equal(tasks.Ada[0].text, "Call mom");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "members.json"), "utf-8")), ["Shopping", "Ada", "Me"]);
	fs.rmSync(dir, { recursive: true, force: true });
});

const w = require("../modules/MMM-HomeWeather/weather");

test("weather line: parseCurrent reads Google current conditions", () => {
	const c = w.parseCurrent({
		isDaytime: true,
		weatherCondition: { iconBaseUri: "https://maps.gstatic.com/weather/v1/sunny", description: { text: "Sunny", languageCode: "en" }, type: "CLEAR" },
		temperature: { degrees: 56.6, unit: "FAHRENHEIT" }
	});
	assert.deepEqual(c, { temp: 57, unit: "°F", text: "Sunny", icon: "https://maps.gstatic.com/weather/v1/sunny.svg", isDay: true });
	assert.deepEqual(w.parseCurrent({}), { temp: null, unit: "°", text: "", icon: null, isDay: true });
});

test("weather line: parseDays reads today's high and low", () => {
	const days = w.parseDays({ forecastDays: [{
		displayDate: { year: 2026, month: 10, day: 28 },
		daytimeForecast: { weatherCondition: { type: "PARTLY_CLOUDY", description: { text: "Partly sunny" } } },
		maxTemperature: { degrees: 38.2, unit: "FAHRENHEIT" },
		minTemperature: { degrees: 15.1, unit: "FAHRENHEIT" }
	}] });
	assert.deepEqual(days, [{ date: { y: 2026, m: 10, d: 28 }, high: 38, low: 15, icon: null, text: "Partly sunny" }]);
	assert.deepEqual(w.parseDays({}), []);
});

test("weather line: Google errors become plain sentences without the key", () => {
	assert.match(w.googleError("Weather API", 403, { error: { message: "Weather API has not been used in project 1 before or it is disabled.", status: "PERMISSION_DENIED" } }), /not enabled for this Google key/);
	assert.match(w.googleError("Weather API", 400, { error: { message: "API key not valid. Please pass a valid API key." } }), /not valid/);
	assert.match(w.googleError("Weather API", 429, null), /quota/);
	assert.match(w.googleError("Weather API", 500, null), /HTTP 500/);
});
