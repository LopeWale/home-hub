/* Place information for the globe page, fetched on the Pi (never in the browser):
 *   - Google Weather API: current conditions, hourly and daily forecast
 *   - Google Air Quality API: current air quality
 *   - Google Geocoding API (reverse): the name of a tapped spot
 *   - Google Time Zone API: local time when the Weather API has no data there
 *   - Google News RSS search: headlines for the place name. Google has no
 *     official news API; this public feed needs no key but is unofficial and
 *     may change without notice.
 *   - Wikipedia (REST summary + geosearch): about text, photo, nearby places.
 *   - Wikidata (SPARQL): country capital, population, currency, languages.
 *     (REST Countries now needs an account and key, so it is not used.)
 *
 * Parsing is kept in pure functions so tests can run without network.
 * Errors never include request URLs, because they contain the key.
 */
"use strict";

const TIMEOUT_MS = 12000;

class ApiError extends Error {}

/** Turn a Google JSON error into a sentence a person can act on. */
function googleError (api, status, body) {
	const err = body && body.error ? body.error : {};
	const msg = String(err.message || "");
	if (status === 403 && /not been used|is disabled|SERVICE_DISABLED/i.test(msg + JSON.stringify(err.details || ""))) {
		return api + " is not enabled for this Google key. Enable it in Google Cloud (APIs & Services).";
	}
	if (status === 403 && /referer|referrer|API key/i.test(msg)) return api + ": the Google key is not allowed to call it (check the key's API restrictions).";
	if (status === 400 && /API key not valid/i.test(msg)) return api + ": the Google key is not valid (SECRET_GOOGLE_MAPS_KEY).";
	if (status === 404 || /not supported|unsupported/i.test(msg)) return api + " has no data for this location.";
	if (status === 429) return api + ": Google's quota is used up for now. Try again later.";
	return api + " failed (HTTP " + status + (err.status ? " " + err.status : "") + ").";
}

async function getJson (api, url, init) {
	let res;
	try {
		res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(TIMEOUT_MS) }, init));
	} catch (err) {
		throw new ApiError(api + ": no answer (" + (err.name === "TimeoutError" ? "timed out" : "no connection") + ").");
	}
	let body = null;
	try {
		body = await res.json();
	} catch {
		// non JSON error page
	}
	if (!res.ok) throw new ApiError(googleError(api, res.status, body));
	return body;
}

function q (params) {
	return Object.entries(params).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
}

function round (n) {
	return Number.isFinite(n) ? Math.round(n) : null;
}

function unitSymbol (unit) {
	return unit === "CELSIUS" ? "°C" : unit === "FAHRENHEIT" ? "°F" : "°";
}

function icon (cond, dark) {
	// iconBaseUri + ".svg" is Google's documented icon URL; "_dark" variants exist too.
	return cond && cond.iconBaseUri ? cond.iconBaseUri + (dark ? "_dark" : "") + ".svg" : null;
}

function text (cond) {
	return cond && cond.description && cond.description.text ? String(cond.description.text) : "";
}

// ---------------------------------------------------------------- weather

/** "NORTH_NORTHWEST" -> "NNW" */
function compass (cardinal) {
	const short = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW" };
	return String(cardinal).split("_").map((w) => short[w] || "").join("");
}

function parseCurrent (body) {
	const t = body.temperature || {};
	const hist = body.currentConditionsHistory || {};
	const wind = body.wind || {};
	return {
		timeZone: body.timeZone && body.timeZone.id ? body.timeZone.id : null,
		temp: round(t.degrees),
		unit: unitSymbol(t.unit),
		feels: round(body.feelsLikeTemperature && body.feelsLikeTemperature.degrees),
		text: text(body.weatherCondition),
		icon: icon(body.weatherCondition),
		isDay: body.isDaytime !== false,
		humidity: round(body.relativeHumidity),
		uv: round(body.uvIndex),
		rain: round(body.precipitation && body.precipitation.probability && body.precipitation.probability.percent),
		wind: round(wind.speed && wind.speed.value),
		windUnit: wind.speed && wind.speed.unit === "KILOMETERS_PER_HOUR" ? "km/h" : "mph",
		windFrom: wind.direction && wind.direction.cardinal ? compass(wind.direction.cardinal) : "",
		high: round(hist.maxTemperature && hist.maxTemperature.degrees),
		low: round(hist.minTemperature && hist.minTemperature.degrees)
	};
}

function parseHours (body) {
	return (body.forecastHours || []).map((h) => ({
		start: h.interval && h.interval.startTime,
		hour: h.displayDateTime ? h.displayDateTime.hours : null,
		temp: round(h.temperature && h.temperature.degrees),
		icon: icon(h.weatherCondition),
		text: text(h.weatherCondition),
		rain: round(h.precipitation && h.precipitation.probability && h.precipitation.probability.percent)
	}));
}

function parseDays (body) {
	return (body.forecastDays || []).map((d) => {
		const day = d.daytimeForecast || {};
		const sun = d.sunEvents || {};
		const moon = d.moonEvents || {};
		return {
			sunrise: sun.sunriseTime || null,
			sunset: sun.sunsetTime || null,
			moonPhase: moon.moonPhase ? String(moon.moonPhase) : null,
			date: d.displayDate ? { y: d.displayDate.year, m: d.displayDate.month, d: d.displayDate.day } : null,
			high: round(d.maxTemperature && d.maxTemperature.degrees),
			low: round(d.minTemperature && d.minTemperature.degrees),
			icon: icon(day.weatherCondition),
			text: text(day.weatherCondition),
			rain: round(day.precipitation && day.precipitation.probability && day.precipitation.probability.percent)
		};
	});
}

async function fetchWeather (key, lat, lng, units, lang) {
	const base = "https://weather.googleapis.com/v1/";
	const loc = { key, "location.latitude": lat, "location.longitude": lng, unitsSystem: units === "metric" ? "METRIC" : "IMPERIAL", languageCode: lang || "en" };
	const [cur, hours, days] = await Promise.all([
		getJson("Weather API", base + "currentConditions:lookup?" + q(loc)),
		getJson("Weather API", base + "forecast/hours:lookup?" + q(Object.assign({ hours: 12, pageSize: 12 }, loc))),
		getJson("Weather API", base + "forecast/days:lookup?" + q(Object.assign({ days: 10, pageSize: 10 }, loc)))
	]);
	return { current: parseCurrent(cur), hours: parseHours(hours), days: parseDays(days) };
}

// ---------------------------------------------------------------- air quality

/** Prefer the local index (US EPA AQI in the US) over Google's universal index. */
function parseAir (body) {
	const indexes = (body && body.indexes) || [];
	const pick = indexes.find((i) => i.code !== "uaqi") || indexes[0];
	if (!pick) return null;
	const c = pick.color || {};
	const hex = (v) => Math.round((Number(v) || 0) * 255).toString(16).padStart(2, "0");
	return {
		name: String(pick.displayName || "Air quality"),
		aqi: pick.aqiDisplay !== undefined ? String(pick.aqiDisplay) : String(pick.aqi ?? ""),
		category: String(pick.category || ""),
		dominant: String(pick.dominantPollutant || "").toUpperCase(),
		color: "#" + hex(c.red) + hex(c.green) + hex(c.blue)
	};
}

async function fetchAir (key, lat, lng, lang) {
	const body = await getJson("Air Quality API", "https://airquality.googleapis.com/v1/currentConditions:lookup?" + q({ key }), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ location: { latitude: lat, longitude: lng }, extraComputations: ["LOCAL_AQI"], languageCode: lang || "en" })
	});
	return parseAir(body);
}

// ---------------------------------------------------------------- reverse geocoding

/** Names for a spot: a short label, the area line and the words used for news. */
function parseReverse (body) {
	const results = (body && body.results) || [];
	const comp = (type, short) => {
		for (const r of results) {
			const c = (r.address_components || []).find((a) => (a.types || []).includes(type));
			if (c) return short ? c.short_name : c.long_name;
		}
		return "";
	};
	const locality = comp("locality") || comp("postal_town") || comp("administrative_area_level_2");
	const region = comp("administrative_area_level_1");
	const country = comp("country");
	const natural = comp("natural_feature");
	if (!locality && !region && !country) {
		return natural ? { label: natural, area: "", newsQuery: natural, locality: "", region: "", country: "", countryCode: "" } : null;
	}
	const countryCode = comp("country", true);
	const label = locality || region || country;
	const area = [locality ? region : "", country].filter((p) => p && p !== label).join(", ");
	// "Paris" alone finds celebrity gossip; "Paris France" finds Paris. In the US the state works better.
	const qualifier = comp("country", true) === "US" ? region : country;
	const newsQuery = [label, qualifier !== label ? qualifier : ""].filter(Boolean).join(" ");
	return { label, area, newsQuery, locality, region, country, countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : "" };
}

async function fetchReverse (key, lat, lng, lang) {
	const body = await getJson("Geocoding API", "https://maps.googleapis.com/maps/api/geocode/json?" + q({ latlng: lat + "," + lng, key, language: lang || "en", result_type: "locality|postal_town|administrative_area_level_2|administrative_area_level_1|country|natural_feature" }));
	if (body.status === "ZERO_RESULTS") return null;
	if (body.status !== "OK") throw new ApiError("Geocoding API: " + body.status + (body.status === "REQUEST_DENIED" ? " (is the Geocoding API enabled for the key?)" : ""));
	return parseReverse(body);
}

// ---------------------------------------------------------------- time zone

async function fetchTimeZone (key, lat, lng) {
	const body = await getJson("Time Zone API", "https://maps.googleapis.com/maps/api/timezone/json?" + q({ location: lat + "," + lng, timestamp: Math.floor(Date.now() / 1000), key }));
	if (body.status !== "OK") throw new ApiError("Time Zone API: " + body.status);
	return body.timeZoneId || null;
}

// ---------------------------------------------------------------- news

function decodeXml (s) {
	return String(s)
		.replace(/^<!\[CDATA\[|\]\]>$/g, "")
		.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&amp;/g, "&");
}

function parseNewsRss (xml, max) {
	const items = [];
	const re = /<item>([\s\S]*?)<\/item>/g;
	let m;
	while ((m = re.exec(xml)) && items.length < max) {
		const get = (tag) => {
			const t = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">").exec(m[1]);
			return t ? decodeXml(t[1]).trim() : "";
		};
		const source = get("source");
		let title = get("title");
		// Google News titles end with " - Source"; the source is shown separately.
		if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
		const published = Date.parse(get("pubDate"));
		if (title) items.push({ title: title.slice(0, 220), source: source.slice(0, 60), published: Number.isFinite(published) ? new Date(published).toISOString() : null });
	}
	return items;
}

async function fetchNews (query, lang, country, max) {
	const hl = (lang || "en") + "-" + (country || "US");
	const url = "https://news.google.com/rss/search?" + q({ q: query, hl, gl: country || "US", ceid: (country || "US") + ":" + (lang || "en") });
	let res;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": "Mozilla/5.0 (MagicMirror fridge)" } });
	} catch (err) {
		throw new ApiError("News: no answer (" + (err.name === "TimeoutError" ? "timed out" : "no connection") + ").");
	}
	if (!res.ok) throw new ApiError("News: Google News answered HTTP " + res.status + ".");
	// The feed is ordered by relevance; show the newest of the most relevant.
	return parseNewsRss(await res.text(), 12)
		.sort((a, b) => (b.published || "").localeCompare(a.published || ""))
		.slice(0, max || 6);
}

// ---------------------------------------------------------------- Wikipedia and Wikidata

const UA = { "User-Agent": "MagicMirror-FridgePlanner/1.0 (personal home display; https://github.com/MagicMirrorOrg/MagicMirror)" };

function parseWikiSummary (body) {
	if (!body || body.type !== "standard" || !body.extract) return null;
	return {
		title: String(body.title || "").slice(0, 80),
		description: String(body.description || "").slice(0, 120),
		extract: String(body.extract).slice(0, 700),
		image: body.thumbnail && /^https:\/\/[a-z.]*wikimedia\.org\//.test(body.thumbnail.source) ? body.thumbnail.source : null
	};
}

/** Wikipedia article for a place: "Town, State" first (US style titles), then the bare name. */
async function fetchAbout (names) {
	const tries = [];
	if (names.locality && names.region) tries.push(names.locality + ", " + names.region);
	if (names.label) tries.push(names.label);
	for (const title of tries) {
		try {
			const res = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title) + "?redirect=true", { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) });
			if (!res.ok) continue;
			const about = parseWikiSummary(await res.json());
			if (about) return about;
		} catch {
			// try the next title
		}
	}
	return null;
}

// Wikipedia coordinate types that are places you could visit (not events, cities or "null").
const PLACE_TYPES = new Set(["landmark", "building", "church", "railwaystation", "airport", "edu", "mountain", "waterbody", "river", "isle", "forest", "glacier", "camera"]);
// Some articles about events or topics still carry a landmark coordinate.
const NOT_A_PLACE = /^(Timeline|List|History|Outline|Index) of\b|^\d{4}\b|\b(ceremony|bombing|shooting|attack|massacre|riot|siege|fire of|explosion|crash)\b/i;

function parseGeosearch (body, skipTitle) {
	return (((body || {}).query || {}).geosearch || [])
		.filter((g) => g.title && g.title !== skipTitle && Number.isFinite(g.lat) && Number.isFinite(g.lon))
		.filter((g) => (g.type === undefined || PLACE_TYPES.has(g.type)) && !NOT_A_PLACE.test(g.title))
		.map((g) => ({ title: String(g.title).slice(0, 80), lat: g.lat, lng: g.lon, meters: Math.round(g.dist || 0) }))
		.slice(0, 8);
}

async function fetchNearby (lat, lng, skipTitle) {
	const url = "https://en.wikipedia.org/w/api.php?" + q({ action: "query", list: "geosearch", gscoord: lat + "|" + lng, gsradius: 10000, gslimit: 50, gsprop: "type", format: "json" });
	const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new ApiError("Wikipedia: HTTP " + res.status);
	return parseGeosearch(await res.json(), skipTitle);
}

/** Regional indicator letters: "FR" -> flag emoji. */
function flagEmoji (code) {
	return /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "";
}

function parseCountry (body, code) {
	const rows = (((body || {}).results || {}).bindings) || [];
	if (!rows.length) return null;
	const set = (key) => Array.from(new Set(rows.map((r) => r[key] && r[key].value).filter((v) => v && !/^Q\d+$/.test(v))));
	const pops = rows.map((r) => Number(r.population && r.population.value)).filter(Number.isFinite);
	return {
		code,
		flag: flagEmoji(code),
		name: set("countryLabel")[0] || code,
		capital: set("capitalLabel").slice(0, 2).join(", "),
		population: pops.length ? Math.max(...pops) : null,
		currencies: set("currencyLabel").slice(0, 2),
		// Wikidata lists every official language, including those of overseas
		// territories (the US gets Spanish, Chamorro, Hawaiian...). More than three
		// is more misleading than useful, so then none are shown.
		languages: set("languageLabel").length <= 3 ? set("languageLabel") : []
	};
}

async function fetchCountry (code) {
	if (!/^[A-Z]{2}$/.test(code)) return null;
	const sparql = "SELECT ?countryLabel ?capitalLabel ?population ?currencyLabel ?languageLabel WHERE { ?country wdt:P297 \"" + code + "\" . " +
		"OPTIONAL { ?country wdt:P36 ?capital. } OPTIONAL { ?country wdt:P1082 ?population. } OPTIONAL { ?country wdt:P38 ?currency. } " +
		"OPTIONAL { ?country wdt:P37 ?language. } SERVICE wikibase:label { bd:serviceParam wikibase:language \"en,mul\". } }";
	const res = await fetch("https://query.wikidata.org/sparql?" + q({ query: sparql }), { headers: Object.assign({ Accept: "application/sparql-results+json" }, UA), signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new ApiError("Wikidata: HTTP " + res.status);
	return parseCountry(await res.json(), code);
}

module.exports = {
	parseWikiSummary,
	parseGeosearch,
	parseCountry,
	flagEmoji,
	fetchAbout,
	fetchNearby,
	fetchCountry,
	ApiError,
	googleError,
	parseCurrent,
	parseHours,
	parseDays,
	parseAir,
	parseReverse,
	parseNewsRss,
	fetchWeather,
	fetchAir,
	fetchReverse,
	fetchTimeZone,
	fetchNews
};
