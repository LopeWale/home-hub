/* MMM-GameDetails node_helper: fetches ESPN's game summary for the game the
 * screen asks about and returns the parsed shape (see espn.js). Cached for
 * 20 s while a game is live and 10 min otherwise. */
"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");
const { PATH_RE, ID_RE, parseSummary } = require("./espn");

module.exports = NodeHelper.create({
	start () {
		this.cache = new Map(); // "path|id" -> { at, data }
	},

	async summary (espnPath, gameId) {
		const key = espnPath + "|" + gameId;
		const hit = this.cache.get(key);
		const ttl = hit && hit.data.state === "in" ? 20000 : 10 * 60 * 1000;
		if (hit && Date.now() - hit.at < ttl) return hit.data;
		const url = "https://site.api.espn.com/apis/site/v2/sports/" + espnPath + "/summary?event=" + gameId;
		const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
		if (!res.ok) throw new Error("ESPN answered HTTP " + res.status);
		const data = parseSummary(await res.json(), espnPath);
		this.cache.set(key, { at: Date.now(), data });
		if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
		return data;
	},

	async socketNotificationReceived (notification, payload) {
		if (notification !== "GD_GET") return;
		const espnPath = String((payload && payload.espnPath) || "");
		const gameId = String((payload && payload.gameId) || "");
		if (!PATH_RE.test(espnPath) || !ID_RE.test(gameId)) return;
		try {
			this.sendSocketNotification("GD_DATA", { gameId, data: await this.summary(espnPath, gameId) });
		} catch (err) {
			Log.warn("[MMM-GameDetails] " + espnPath + " " + gameId + ": " + err.message);
			this.sendSocketNotification("GD_DATA", { gameId, error: err.name === "TimeoutError" ? "ESPN did not answer in time." : "Could not load game details (" + err.message + ")." });
		}
	}
});
