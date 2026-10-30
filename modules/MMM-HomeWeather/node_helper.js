/* MMM-HomeWeather node_helper: asks Google for today's weather at home.
 * The key (SECRET_GOOGLE_MAPS_KEY) and the location (HOME_LAT / HOME_LNG) are
 * read from process.env (MagicMirror loads config/config.env into it) and
 * never sent to the browser. One round at a time; the last good answer is kept
 * and re-sent to a reloaded page. */
"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");
const { fetchToday } = require("./weather");

const RETRY_MS = 5 * 60 * 1000; // after a failed round

function coord (name) {
	const n = Number.parseFloat(process.env[name]);
	// 2 decimals (about 1 km) is plenty for a forecast.
	return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

module.exports = NodeHelper.create({
	start () {
		this.config = null;
		this.timer = null;
		this.busy = false;
		this.last = null; // { weather, at }
	},

	stop () {
		clearTimeout(this.timer);
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "HW_INIT") return;
		this.config = payload || {};
		if (this.last) this.sendSocketNotification("HW_DATA", this.last);
		if (!this.timer && !this.busy) this.update();
	},

	schedule (ms) {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.update();
		}, ms);
	},

	async update () {
		if (this.busy) return;
		this.busy = true;
		const key = process.env.SECRET_GOOGLE_MAPS_KEY;
		const lat = coord("HOME_LAT");
		const lng = coord("HOME_LNG");
		let next = this.config.updateMs || 30 * 60 * 1000;
		try {
			if (!key || lat === null || lng === null) throw new Error("set SECRET_GOOGLE_MAPS_KEY, HOME_LAT and HOME_LNG in config.env");
			const weather = await fetchToday(key, lat, lng, this.config.units, this.config.lang);
			this.last = { weather, at: Date.now() };
			this.sendSocketNotification("HW_DATA", this.last);
		} catch (err) {
			Log.warn("[MMM-HomeWeather] " + err.message);
			this.sendSocketNotification("HW_ERROR", { message: err.message });
			next = RETRY_MS;
		} finally {
			this.busy = false;
			this.schedule(next);
		}
	}
});
