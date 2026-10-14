/* MMM-GlobeWeatherBridge node_helper
 *
 * - Geocodes searches server side. The Google key is read from
 *   process.env.SECRET_GOOGLE_MAPS_KEY (MagicMirror loads config/config.env
 *   into process.env) and is never sent to the browser.
 * - Caches every geocode result in data/state.json so boots do not geocode.
 * - Stores pins added from the touchscreen in data/state.json.
 * - Home, in order: coordinates from config or the admin page, then the
 *   address (geocoded once), then automatic location (Wi-Fi positioning,
 *   falling back to an internet lookup, see locate.js). The automatic result
 *   is cached in data/state.json and redone only after AUTO_HOME_TTL_MS.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { locateHome } = require("./locate");
const info = require("./placeinfo");

const STATE_VERSION = 1;
const CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const MIN_GAP_MS = 1100; // also satisfies Nominatim style 1 req/s etiquette
const DAILY_CAP = 300; // protects the Google billing account from a stuck loop
const AUTO_HOME_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/* Place info budgets. Google gives 10,000 free calls a month per API
 * (Weather, Air Quality, Geocoding, Time Zone). One weather refresh is 3
 * calls (now, hours, days). Home every 30 min = 144 weather calls a day,
 * leaving room for taps under the daily caps below (300 x 30 = 9,000). */
const DAILY_CAPS = { weather: 300, air: 150, reverse: 200, timezone: 60, news: 400, wiki: 600 };
const WIKI_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AIR_TTL_MS = 60 * 60 * 1000;
const NEWS_TTL_MS = 30 * 60 * 1000;
const REVERSE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function cleanText (value, max) {
	return String(value || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
}

function validCoords (lat, lng) {
	return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** config.js leaves "${HOME_ADDRESS}" as literal text when config.env does not set it. */
function unsetValue (value) {
	return value === undefined || value === null || String(value).trim() === "" || String(value).includes("${");
}

module.exports = NodeHelper.create({
	start () {
		this.stateFile = path.join(this.path, "data", "state.json");
		this.state = this.loadState();
		this.lastCall = 0;
		this.day = new Date().toDateString();
		this.callsToday = 0;
		this.queue = Promise.resolve();
		this.infoCache = new Map(); // "kind:lat,lng" -> { at, value } (weather, air, news, timezone)
		this.infoDay = new Date().toDateString();
		this.infoCalls = {};
	},

	// ---------- persistence ----------

	loadState () {
		try {
			const data = JSON.parse(fs.readFileSync(this.stateFile, "utf-8"));
			if (data && data.version === STATE_VERSION) {
				return { version: STATE_VERSION, userPins: Array.isArray(data.userPins) ? data.userPins : [], geocodeCache: data.geocodeCache || {}, autoHome: data.autoHome || null };
			}
		} catch (err) {
			if (err.code !== "ENOENT") Log.warn("[MMM-GlobeWeatherBridge] state.json unreadable, starting fresh: " + err.message);
		}
		return { version: STATE_VERSION, userPins: [], geocodeCache: {}, autoHome: null };
	},

	saveState () {
		try {
			fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
			const tmp = this.stateFile + ".tmp";
			const fd = fs.openSync(tmp, "w");
			fs.writeFileSync(fd, JSON.stringify(this.state, null, 2));
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fs.renameSync(tmp, this.stateFile);
		} catch (err) {
			Log.error("[MMM-GlobeWeatherBridge] could not save state: " + err.message);
		}
	},

	// ---------- geocoding ----------

	cacheGet (key) {
		const hit = this.state.geocodeCache[key];
		if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;
		return null;
	},

	cachePut (key, results) {
		this.state.geocodeCache[key] = { at: Date.now(), results };
		const keys = Object.keys(this.state.geocodeCache);
		if (keys.length > CACHE_MAX) {
			keys.sort((a, b) => this.state.geocodeCache[a].at - this.state.geocodeCache[b].at);
			for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete this.state.geocodeCache[k];
		}
		this.saveState();
	},

	/** Serialised, rate limited, cached geocode. Resolves to {results, error, source}. */
	geocode (query, limit) {
		const job = this.queue.then(() => this.geocodeNow(query, limit));
		this.queue = job.catch(() => {});
		return job;
	},

	async geocodeNow (query, limit) {
		const provider = process.env.SECRET_GOOGLE_MAPS_KEY && this.config.geocoder !== "openmeteo" ? "google" : "openmeteo";
		const key = provider + ":" + query.toLowerCase().replace(/\s+/g, " ");
		const cached = this.cacheGet(key);
		if (cached) return { results: cached.slice(0, limit), source: provider + " (cached)" };

		const today = new Date().toDateString();
		if (today !== this.day) {
			this.day = today;
			this.callsToday = 0;
		}
		if (this.callsToday >= DAILY_CAP) return { results: [], error: "Daily geocoding limit reached (" + DAILY_CAP + ")" };
		const wait = this.lastCall + MIN_GAP_MS - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		this.lastCall = Date.now();
		this.callsToday += 1;

		try {
			const results = provider === "google" ? await this.google(query) : await this.openMeteo(query);
			// Only successful lookups are cached, so a key or network problem is retried later.
			this.cachePut(key, results);
			return { results: results.slice(0, limit), source: provider };
		} catch (err) {
			Log.error("[MMM-GlobeWeatherBridge] geocode failed (" + provider + "): " + err.message);
			return { results: [], error: err.message };
		}
	},

	async google (query) {
		const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(query) + "&key=" + encodeURIComponent(process.env.SECRET_GOOGLE_MAPS_KEY);
		const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
		if (!res.ok) throw new Error("Google geocoding HTTP " + res.status);
		const body = await res.json();
		if (body.status === "ZERO_RESULTS") return [];
		// error_message can echo request details, never log the URL itself.
		if (body.status !== "OK") throw new Error("Google geocoding " + body.status);
		return body.results.map((r) => ({
			label: cleanText(String(r.formatted_address || "").split(",")[0], 40),
			address: cleanText(r.formatted_address, 200),
			lat: r.geometry.location.lat,
			lng: r.geometry.location.lng
		})).filter((r) => validCoords(r.lat, r.lng));
	},

	async openMeteo (query) {
		const url = "https://geocoding-api.open-meteo.com/v1/search?count=10&format=json&language=" + encodeURIComponent(this.config.language || "en") + "&name=" + encodeURIComponent(query);
		const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
		if (!res.ok) throw new Error("Open-Meteo geocoding HTTP " + res.status);
		const body = await res.json();
		return (body.results || []).map((r) => ({
			label: cleanText(r.name, 40),
			address: cleanText([r.name, r.admin1, r.country].filter(Boolean).join(", "), 200),
			lat: r.latitude,
			lng: r.longitude
		})).filter((r) => validCoords(r.lat, r.lng));
	},

	/** Fill lat/lng for a configured place from its address (cached). */
	async resolvePlace (place, kind) {
		if (!place || typeof place !== "object") return null;
		const lat = Number(place.lat);
		const lng = Number(place.lng);
		const address = unsetValue(place.address) ? "" : place.address;
		const base = { id: kind + ":" + (place.label || address || ""), kind, label: cleanText(place.label || "Pin", 40), address: cleanText(address, 200) };
		if (!unsetValue(place.lat) && validCoords(lat, lng)) return Object.assign(base, { lat, lng });
		if (!base.address) return null;
		const { results, error } = await this.geocode(base.address, 1);
		if (results.length === 0) {
			Log.warn("[MMM-GlobeWeatherBridge] could not geocode " + kind + " '" + base.label + "'" + (error ? ": " + error : ""));
			return null;
		}
		return Object.assign(base, { lat: results[0].lat, lng: results[0].lng });
	},

	/** Automatic home location, cached. Runs at most once at a time. */
	autoLocateHome () {
		const cached = this.state.autoHome;
		if (cached && Date.now() - cached.at < AUTO_HOME_TTL_MS && validCoords(cached.lat, cached.lng)) return Promise.resolve(cached);
		if (!this.autoLocating) {
			this.autoLocating = locateHome({
				googleKey: process.env.SECRET_GOOGLE_MAPS_KEY,
				log: (msg) => Log.warn("[MMM-GlobeWeatherBridge] " + msg)
			}).then((found) => {
				this.autoLocating = null;
				if (!found) return null;
				this.state.autoHome = Object.assign({ at: Date.now() }, found);
				this.saveState();
				Log.log("[MMM-GlobeWeatherBridge] home located automatically (" + found.source + ")");
				return this.state.autoHome;
			});
		}
		return this.autoLocating;
	},

	async resolveHome () {
		const configured = await this.resolvePlace(this.config.home, "home");
		if (configured || this.config.autoLocate === false) return configured;
		const found = await this.autoLocateHome();
		if (!found) return null;
		const how = found.source === "wifi"
			? "found automatically from nearby Wi-Fi" + (found.accuracy ? ", about " + Math.round(found.accuracy) + " m" : "")
			: "found automatically from your internet connection, city level";
		const label = this.config.home && !unsetValue(this.config.home.label) ? this.config.home.label : "Home";
		return {
			id: "home:auto",
			kind: "home",
			label: cleanText(label, 40),
			address: cleanText((found.address ? found.address + " " : "") + "(" + how + ")", 200),
			lat: found.lat,
			lng: found.lng,
			auto: true
		};
	},

	async sendState () {
		const home = await this.resolveHome();
		const pins = [];
		for (const [i, pin] of (this.config.pins || []).entries()) {
			const resolved = await this.resolvePlace(pin, "admin");
			if (resolved) pins.push(Object.assign(resolved, { id: "admin:" + i }));
		}
		this.sendSocketNotification("GWB_STATE", {
			home,
			pins,
			userPins: this.state.userPins,
			geocoder: process.env.SECRET_GOOGLE_MAPS_KEY && this.config.geocoder !== "openmeteo" ? "google" : "openmeteo"
		});
	},

	// ---------- place info (weather, air, news) ----------

	/** Count one call against today's cap for an API. False when the cap is reached. */
	spend (api) {
		const today = new Date().toDateString();
		if (today !== this.infoDay) {
			this.infoDay = today;
			this.infoCalls = {};
		}
		const used = this.infoCalls[api] || 0;
		if (used >= DAILY_CAPS[api]) return false;
		this.infoCalls[api] = used + 1;
		return true;
	},

	/** Cached call: a hit younger than ttl is returned; failures are not cached. */
	async cached (kind, key, ttl, api, cost, fn) {
		const id = kind + ":" + key;
		const hit = this.infoCache.get(id);
		if (hit && Date.now() - hit.at < ttl) return hit.value;
		for (let i = 0; i < cost; i++) {
			if (!this.spend(api)) throw new info.ApiError("Daily limit for the " + api + " lookups reached (keeps you inside Google's free tier). It resets at midnight.");
		}
		const value = await fn();
		this.infoCache.set(id, { at: Date.now(), value });
		if (this.infoCache.size > 400) this.infoCache.delete(this.infoCache.keys().next().value);
		return value;
	},

	/** Area names for a spot, cached for months in state.json. */
	async reverseName (key, lat, lng) {
		const id = "rev:" + lat.toFixed(2) + "," + lng.toFixed(2);
		const hit = this.state.geocodeCache[id];
		if (hit && Date.now() - hit.at < REVERSE_TTL_MS) return hit.results;
		if (!key) return null;
		if (!this.spend("reverse")) return null;
		const found = await info.fetchReverse(key, lat, lng, this.config.language);
		this.cachePut(id, found);
		return found;
	},

	async placeInfo (p) {
		const key = process.env.SECRET_GOOGLE_MAPS_KEY;
		const lat = Number(p.lat);
		const lng = Number(p.lng);
		const spot = lat.toFixed(2) + "," + lng.toFixed(2);
		const lang = this.config.language || "en";
		const weatherTtl = Math.max(5, Number(this.config.weatherRefreshMin) || 30) * 60 * 1000 - 60 * 1000;
		const out = { requestId: p.requestId, lat, lng, place: { label: cleanText(p.label, 60), area: "" } };
		const noKey = "Add SECRET_GOOGLE_MAPS_KEY to config.env (Weather and Air Quality APIs enabled on it).";

		let names = null;
		try {
			names = await this.reverseName(key, lat, lng);
		} catch (err) {
			Log.warn("[MMM-GlobeWeatherBridge] reverse geocode: " + err.message);
		}
		if (names) {
			if (!out.place.label) out.place.label = names.label; // plain taps send no label
			out.place.area = names.area;
		} else if (!out.place.label) {
			// With a key, no name means sea or wilderness; without one we just do not know.
			out.place.label = key ? "Open water" : Math.abs(lat).toFixed(2) + "° " + (lat >= 0 ? "N" : "S") + ", " + Math.abs(lng).toFixed(2) + "° " + (lng >= 0 ? "E" : "W");
		}
		// Without the place name only a real place label is searched; "Home" or
		// "Our house" would find unrelated headlines.
		const newsQuery = names ? names.newsQuery : p.kind === "admin" || p.kind === "user" ? out.place.label : "";

		const aboutKey = names ? (names.locality + "|" + names.region + "|" + names.label).toLowerCase() : "";
		const [weather, air, news, about, nearby, country] = await Promise.allSettled([
			key ? this.cached("weather", spot, weatherTtl, "weather", 3, () => info.fetchWeather(key, lat, lng, this.config.units, lang)) : Promise.reject(new Error(noKey)),
			key ? this.cached("air", spot, AIR_TTL_MS, "air", 1, () => info.fetchAir(key, lat, lng, lang)) : Promise.reject(new Error(noKey)),
			newsQuery ? this.cached("news", newsQuery.toLowerCase(), NEWS_TTL_MS, "news", 1, () => info.fetchNews(newsQuery, lang.slice(0, 2), "US", 6)) : Promise.reject(new Error(key ? "No town or city here, so no local headlines." : "Local headlines need the place name: " + noKey)),
			// Free, no key: Wikipedia about + nearby, Wikidata country facts.
			names ? this.cached("about", aboutKey, WIKI_TTL_MS, "wiki", 1, () => info.fetchAbout(names)) : Promise.resolve(null),
			this.cached("nearby", spot, WIKI_TTL_MS, "wiki", 1, () => info.fetchNearby(lat, lng, "")),
			names && names.countryCode ? this.cached("country", names.countryCode, 30 * 24 * 60 * 60 * 1000, "wiki", 1, () => info.fetchCountry(names.countryCode)) : Promise.resolve(null)
		]);
		out.about = about.status === "fulfilled" ? about.value : null;
		out.nearby = nearby.status === "fulfilled" ? nearby.value.filter((n) => !out.about || n.title !== out.about.title) : [];
		out.country = country.status === "fulfilled" ? country.value : null;
		if (weather.status === "fulfilled") out.weather = weather.value;
		else out.weatherError = weather.reason.message;
		if (air.status === "fulfilled") out.air = air.value;
		else out.airError = air.reason.message;
		if (news.status === "fulfilled") out.news = news.value;
		else out.newsError = news.reason.message;
		out.newsQuery = newsQuery;

		// Local time: the Weather API names the zone; otherwise ask the Time Zone API.
		out.timeZone = out.weather && out.weather.current.timeZone;
		if (!out.timeZone && key) {
			try {
				out.timeZone = await this.cached("timezone", spot, REVERSE_TTL_MS, "timezone", 1, () => info.fetchTimeZone(key, lat, lng));
			} catch (err) {
				Log.warn("[MMM-GlobeWeatherBridge] time zone: " + err.message);
			}
		}
		for (const [what, err] of [["weather", out.weatherError], ["air", out.airError], ["news", out.newsError]]) {
			if (err) Log.warn("[MMM-GlobeWeatherBridge] " + what + ": " + err);
		}
		return out;
	},

	// ---------- socket API ----------

	async socketNotificationReceived (notification, payload) {
		try {
			if (notification === "GWB_INIT") {
				// Only non secret settings arrive from the browser.
				this.config = payload || {};
				await this.sendState();
			} else if (notification === "GWB_SEARCH") {
				const query = cleanText(payload && payload.query, 200);
				const requestId = payload && payload.requestId;
				if (query.length < 2) {
					this.sendSocketNotification("GWB_SEARCH_RESULTS", { requestId, results: [], error: "Type at least 2 characters" });
					return;
				}
				const out = await this.geocode(query, Math.min(10, Number(this.config.maxSearchResults) || 5));
				this.sendSocketNotification("GWB_SEARCH_RESULTS", Object.assign({ requestId, query }, out));
			} else if (notification === "GWB_ADD_PIN") {
				const lat = Number(payload && payload.lat);
				const lng = Number(payload && payload.lng);
				if (!validCoords(lat, lng)) return;
				const exists = this.state.userPins.find((p) => Math.abs(p.lat - lat) < 1e-4 && Math.abs(p.lng - lng) < 1e-4);
				if (!exists) {
					if (this.state.userPins.length >= 50) this.state.userPins.shift();
					this.state.userPins.push({ id: "user:" + crypto.randomBytes(4).toString("hex"), kind: "user", label: cleanText(payload.label, 40) || "Pin", address: cleanText(payload.address, 200), lat, lng });
					this.saveState();
				}
				await this.sendState();
			} else if (notification === "GWB_INFO") {
				const lat = Number(payload && payload.lat);
				const lng = Number(payload && payload.lng);
				if (!validCoords(lat, lng)) return;
				this.sendSocketNotification("GWB_INFO_RESULT", await this.placeInfo(Object.assign({}, payload, { lat, lng })));
			} else if (notification === "GWB_ADD_PIN_HERE") {
				// a tapped spot saved as a pin, no geocoding needed
				const lat = Number(payload && payload.lat);
				const lng = Number(payload && payload.lng);
				if (!validCoords(lat, lng)) return;
				if (this.state.userPins.length >= 50) this.state.userPins.shift();
				const pin = { id: "user:" + crypto.randomBytes(4).toString("hex"), kind: "user", label: cleanText(payload.label, 40) || "Pin", address: cleanText(payload.address, 200), lat, lng };
				this.state.userPins.push(pin);
				this.saveState();
				await this.sendState();
				this.sendSocketNotification("GWB_PIN_SAVED", { id: pin.id, lat, lng });
			} else if (notification === "GWB_REMOVE_PIN") {
				const id = payload && payload.id;
				const before = this.state.userPins.length;
				this.state.userPins = this.state.userPins.filter((p) => p.id !== id);
				if (this.state.userPins.length !== before) this.saveState();
				await this.sendState();
			}
		} catch (err) {
			Log.error("[MMM-GlobeWeatherBridge] " + notification + " failed: " + err.message);
		}
	}
});
