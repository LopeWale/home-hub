/* Unit tests for the guest Wi-Fi QR string, the globe page's Google response
 * parsing, the news feed parser and the bridge migration (no network).
 * Run: node --test tests/fridge.test.js
 * Fixtures follow the response examples in Google's Weather, Air Quality and
 * Geocoding API documentation (fetched 2026-10-03). */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { wifiString } = require("../modules/MMM-GuestNet/wifiqr");
const p = require("../modules/MMM-GlobeWeatherBridge/placeinfo");
const { migrate } = require("../scripts/migrate-bridge");

test("wifiString escapes reserved characters and handles open networks", () => {
	assert.equal(wifiString({ ssid: "Guest;1", password: "p:a\\ss,\"x", security: "WPA" }), "WIFI:T:WPA;S:Guest\\;1;P:p\\:a\\\\ss\\,\\\"x;;");
	assert.equal(wifiString({ ssid: "Cafe", password: "", security: "WPA" }), "WIFI:T:nopass;S:Cafe;;");
	assert.equal(wifiString({ ssid: "Hidden", password: "secret12", hidden: true }), "WIFI:T:WPA;S:Hidden;P:secret12;H:true;;");
	assert.equal(wifiString({ ssid: "${GUEST_WIFI_SSID}", password: "x" }), null, "unset config.env placeholder");
	assert.equal(wifiString({ ssid: "" }), null);
});

test("parseCurrent reads Google current conditions", () => {
	const c = p.parseCurrent({
		timeZone: { id: "America/Los_Angeles" },
		isDaytime: true,
		weatherCondition: { iconBaseUri: "https://maps.gstatic.com/weather/v1/sunny", description: { text: "Sunny", languageCode: "en" }, type: "CLEAR" },
		temperature: { degrees: 56.6, unit: "FAHRENHEIT" },
		feelsLikeTemperature: { degrees: 55.7, unit: "FAHRENHEIT" },
		relativeHumidity: 42,
		uvIndex: 1,
		precipitation: { probability: { percent: 0, type: "RAIN" } },
		wind: { direction: { degrees: 335, cardinal: "NORTH_NORTHWEST" }, speed: { value: 5, unit: "MILES_PER_HOUR" } },
		currentConditionsHistory: { maxTemperature: { degrees: 57.8, unit: "FAHRENHEIT" }, minTemperature: { degrees: 38.6, unit: "FAHRENHEIT" } }
	});
	assert.deepEqual(c, {
		timeZone: "America/Los_Angeles", temp: 57, unit: "°F", feels: 56, text: "Sunny",
		icon: "https://maps.gstatic.com/weather/v1/sunny.svg", isDay: true, humidity: 42, uv: 1, rain: 0,
		wind: 5, windUnit: "mph", windFrom: "NNW", high: 58, low: 39
	});
});

test("parseDays and parseHours read Google forecasts", () => {
	const days = p.parseDays({ forecastDays: [{
		displayDate: { year: 2025, month: 2, day: 10 },
		daytimeForecast: { weatherCondition: { type: "PARTLY_CLOUDY", description: { text: "Partly sunny" } }, precipitation: { probability: { percent: 5 } } },
		maxTemperature: { degrees: 13.3, unit: "CELSIUS" },
		minTemperature: { degrees: 1.5, unit: "CELSIUS" }
	}] });
	assert.deepEqual(days, [{ sunrise: null, sunset: null, moonPhase: null, date: { y: 2025, m: 2, d: 10 }, high: 13, low: 2, icon: null, text: "Partly sunny", rain: 5 }]);
	const sunDay = p.parseDays({ forecastDays: [{ sunEvents: { sunriseTime: "2025-02-10T15:02:35Z", sunsetTime: "2025-02-11T01:43:00Z" }, moonEvents: { moonPhase: "WAXING_GIBBOUS" } }] })[0];
	assert.equal(sunDay.sunrise, "2025-02-10T15:02:35Z");
	assert.equal(sunDay.moonPhase, "WAXING_GIBBOUS");
	const hours = p.parseHours({ forecastHours: [{
		interval: { startTime: "2025-02-05T23:00:00Z" },
		displayDateTime: { year: 2025, month: 2, day: 5, hours: 15 },
		weatherCondition: { iconBaseUri: "https://maps.gstatic.com/weather/v1/sunny", description: { text: "Sunny" } },
		temperature: { degrees: 12.7, unit: "CELSIUS" },
		precipitation: { probability: { percent: 0 } }
	}] });
	assert.equal(hours[0].hour, 15);
	assert.equal(hours[0].temp, 13);
	assert.equal(hours[0].icon, "https://maps.gstatic.com/weather/v1/sunny.svg");
	assert.deepEqual(p.parseDays({}), []);
});

test("parseAir prefers the local index and builds a hex color", () => {
	const air = p.parseAir({ indexes: [
		{ code: "uaqi", displayName: "Universal AQI", aqi: 70, aqiDisplay: "70", color: { red: 0.4, green: 0.8, blue: 0.2 }, category: "Good air quality", dominantPollutant: "o3" },
		{ code: "usa_epa", displayName: "AQI (US)", aqi: 42, aqiDisplay: "42", color: { green: 0.89 }, category: "Good air quality", dominantPollutant: "o3" }
	] });
	assert.deepEqual(air, { name: "AQI (US)", aqi: "42", category: "Good air quality", dominant: "O3", color: "#00e300" });
	assert.equal(p.parseAir({ indexes: [] }), null);
});

test("parseReverse names a place and builds the news query", () => {
	const r = (comps) => ({ results: [{ address_components: comps }] });
	const paris = p.parseReverse(r([
		{ long_name: "Paris", short_name: "Paris", types: ["locality", "political"] },
		{ long_name: "Île-de-France", short_name: "IDF", types: ["administrative_area_level_1", "political"] },
		{ long_name: "France", short_name: "FR", types: ["country", "political"] }
	]));
	assert.deepEqual(paris, { label: "Paris", area: "Île-de-France, France", newsQuery: "Paris France", locality: "Paris", region: "Île-de-France", country: "France", countryCode: "FR" });
	const okc = p.parseReverse(r([
		{ long_name: "Oklahoma City", short_name: "Oklahoma City", types: ["locality"] },
		{ long_name: "Oklahoma", short_name: "OK", types: ["administrative_area_level_1"] },
		{ long_name: "United States", short_name: "US", types: ["country"] }
	]));
	assert.equal(okc.newsQuery, "Oklahoma City Oklahoma");
	assert.deepEqual(p.parseReverse(r([{ long_name: "Pacific Ocean", short_name: "Pacific Ocean", types: ["natural_feature"] }])), { label: "Pacific Ocean", area: "", newsQuery: "Pacific Ocean", locality: "", region: "", country: "", countryCode: "" });
	assert.equal(p.parseReverse({ results: [] }), null);
});

test("parseNewsRss strips the source suffix and decodes entities", () => {
	const xml = "<rss><channel><item><title>Rain &amp; wind hit &quot;OKC&quot; - KOCO</title><link>https://x</link>" +
		"<pubDate>Sat, 03 Oct 2026 15:32:00 GMT</pubDate><source url=\"https://koco.com\">KOCO</source></item>" +
		"<item><title><![CDATA[Second story]]></title><pubDate>bad date</pubDate></item></channel></rss>";
	assert.deepEqual(p.parseNewsRss(xml, 5), [
		{ title: "Rain & wind hit \"OKC\"", source: "KOCO", published: "2026-10-03T15:32:00.000Z" },
		{ title: "Second story", source: "", published: null }
	]);
	assert.equal(p.parseNewsRss(xml, 1).length, 1);
});

test("googleError turns API failures into plain sentences", () => {
	assert.match(p.googleError("Weather API", 403, { error: { message: "Weather API has not been used in project 1 before or it is disabled.", status: "PERMISSION_DENIED" } }), /not enabled for this Google key/);
	assert.match(p.googleError("Weather API", 400, { error: { message: "API key not valid. Please pass a valid API key." } }), /not valid/);
	assert.match(p.googleError("Weather API", 404, { error: { message: "Information is not supported for this location." } }), /no data for this location/);
	assert.match(p.googleError("Air Quality API", 500, null), /HTTP 500/);
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

test("Wikipedia and Wikidata parsing for the place panel", () => {
	assert.deepEqual(p.parseWikiSummary({ type: "standard", title: "Norman, Oklahoma", description: "City in Oklahoma", extract: "Norman is a city.", thumbnail: { source: "https://upload.wikimedia.org/x.jpg" } }),
		{ title: "Norman, Oklahoma", description: "City in Oklahoma", extract: "Norman is a city.", image: "https://upload.wikimedia.org/x.jpg" });
	assert.equal(p.parseWikiSummary({ type: "disambiguation", title: "Norman", extract: "Norman may refer to" }), null);
	assert.equal(p.parseWikiSummary({ type: "standard", title: "X", extract: "y", thumbnail: { source: "https://evil.example/x.jpg" } }).image, null, "only Wikimedia images");
	assert.deepEqual(p.parseGeosearch({ query: { geosearch: [{ title: "Eiffel Tower", lat: 48.858, lon: 2.294, dist: 20.4 }, { title: "Paris", lat: 48.85, lon: 2.35, dist: 4000 }] } }, "Paris"),
		[{ title: "Eiffel Tower", lat: 48.858, lng: 2.294, meters: 20 }]);
	assert.equal(p.flagEmoji("FR"), "\u{1F1EB}\u{1F1F7}");
	const b = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
	const c = p.parseCountry({ results: { bindings: [b({ countryLabel: "France", capitalLabel: "Paris", population: "68605616", currencyLabel: "euro", languageLabel: "French" }), b({ countryLabel: "France", capitalLabel: "Paris", population: "67000000", currencyLabel: "Q4916", languageLabel: "French" })] } }, "FR");
	assert.deepEqual(c, { code: "FR", flag: "\u{1F1EB}\u{1F1F7}", name: "France", capital: "Paris", population: 68605616, currencies: ["euro"], languages: ["French"] });
	const many = p.parseCountry({ results: { bindings: ["Spanish", "Chamorro", "Hawaiian", "Samoan"].map((l) => b({ countryLabel: "United States", languageLabel: l })) } }, "US");
	assert.deepEqual(many.languages, [], "more than three official languages are not shown");
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
