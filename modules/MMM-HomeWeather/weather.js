/* Google Weather API for the weather line, fetched on the Pi (never in the
 * browser): current conditions plus today's high and low.
 * The parsing came from the old globe page (MMM-GlobeWeatherBridge/placeinfo.js),
 * which ran on the fridge until 2026-10-27.
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

async function getJson (api, url) {
	let res;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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

function icon (cond) {
	// iconBaseUri + ".svg" is Google's documented icon URL.
	return cond && cond.iconBaseUri ? cond.iconBaseUri + ".svg" : null;
}

function text (cond) {
	return cond && cond.description && cond.description.text ? String(cond.description.text) : "";
}

function parseCurrent (body) {
	const t = body.temperature || {};
	return {
		temp: round(t.degrees),
		unit: unitSymbol(t.unit),
		text: text(body.weatherCondition),
		icon: icon(body.weatherCondition),
		isDay: body.isDaytime !== false
	};
}

function parseDays (body) {
	return (body.forecastDays || []).map((d) => {
		const day = d.daytimeForecast || {};
		return {
			date: d.displayDate ? { y: d.displayDate.year, m: d.displayDate.month, d: d.displayDate.day } : null,
			high: round(d.maxTemperature && d.maxTemperature.degrees),
			low: round(d.minTemperature && d.minTemperature.degrees),
			icon: icon(day.weatherCondition),
			text: text(day.weatherCondition)
		};
	});
}

/** Today at home: { temp, unit, text, icon, isDay, high, low }. */
async function fetchToday (key, lat, lng, units, lang) {
	const base = "https://weather.googleapis.com/v1/";
	const loc = { key, "location.latitude": lat, "location.longitude": lng, unitsSystem: units === "metric" ? "METRIC" : "IMPERIAL", languageCode: lang || "en" };
	const [cur, days] = await Promise.all([
		getJson("Weather API", base + "currentConditions:lookup?" + q(loc)),
		getJson("Weather API", base + "forecast/days:lookup?" + q(Object.assign({ days: 1, pageSize: 1 }, loc)))
	]);
	const today = parseDays(days)[0] || {};
	return Object.assign(parseCurrent(cur), { high: today.high ?? null, low: today.low ?? null });
}

module.exports = { googleError, parseCurrent, parseDays, fetchToday, ApiError };
