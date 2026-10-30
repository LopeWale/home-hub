/* MMM-HomeWeather: one line in the top bar, for example "(icon) 15°  H 38° L 15°".
 * Data from the Google Weather API, fetched on the Pi (node_helper.js).
 * An answer older than staleMs is drawn faded, so old weather never looks current.
 * Sends nothing. Socket: HW_INIT out, HW_DATA / HW_ERROR in. */
Module.register("MMM-HomeWeather", {
	defaults: {
		updateMs: 30 * 60 * 1000, // two Google calls each time
		staleMs: 2 * 60 * 60 * 1000
	},

	getStyles () {
		return ["MMM-HomeWeather.css"];
	},

	start () {
		this.latest = null; // { weather, at } (not this.data: MagicMirror keeps the module settings there)
		this.failed = false;
		this.sendSocketNotification("HW_INIT", { units: config.units, lang: config.language, updateMs: this.config.updateMs });
		// Redraw now and then so an old answer turns faded even without new data.
		setInterval(() => this.updateDom(), 5 * 60 * 1000);
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "HW_DATA" && payload && payload.weather) {
			this.latest = payload;
			this.failed = false;
			this.updateDom();
		} else if (notification === "HW_ERROR") {
			Log.warn("MMM-HomeWeather: " + (payload && payload.message));
			this.failed = true;
			if (!this.latest) this.updateDom();
		}
	},

	getDom () {
		const root = document.createElement("div");
		root.className = "hw-line";
		if (!this.latest) {
			root.classList.add("hw-waiting");
			root.textContent = this.failed ? "Weather unavailable" : "";
			return root;
		}
		const w = this.latest.weather;
		if (Date.now() - this.latest.at > this.config.staleMs) root.classList.add("hw-stale");
		if (w.icon) {
			const img = document.createElement("img");
			img.className = "hw-icon";
			img.src = w.icon;
			img.alt = w.text || "";
			img.onerror = () => img.remove();
			root.appendChild(img);
		}
		const deg = (n) => (n === null || n === undefined ? "–" : n + "°");
		const now = document.createElement("span");
		now.className = "hw-now";
		now.textContent = deg(w.temp);
		root.appendChild(now);
		if (w.high !== null || w.low !== null) {
			const hl = document.createElement("span");
			hl.className = "hw-hl";
			hl.innerHTML = "<span class=\"hw-label\">H</span> " + deg(w.high) + " <span class=\"hw-label\">L</span> " + deg(w.low);
			root.appendChild(hl);
		}
		// Google's Weather API policies ask for this credit on or next to the data.
		const credit = document.createElement("div");
		credit.className = "hw-credit";
		credit.textContent = "Source: Includes weather data from Google";
		root.appendChild(credit);
		return root;
	}
});
