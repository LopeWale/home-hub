/* MMM-GlobeWeatherBridge
 *
 * The globe page: a 3D Earth on the left, a place panel on the right.
 *
 * Earth renderer (config.renderer):
 *   "google3d"  Google's photorealistic 3D Earth (Maps JavaScript API, maps3d
 *               library). Needs a BROWSER key (config.browserKey, from
 *               GOOGLE_MAPS_BROWSER_KEY in config.env) restricted to
 *               http://localhost:8080/* and to the Maps JavaScript + Map Tiles
 *               APIs. Billed per map load: the map is created once and never
 *               rebuilt, so the fridge uses about one load per restart.
 *   "globegl"   The vendored globe.gl Earth. No key in the browser. Used
 *               automatically when the Google map cannot start.
 *
 * Interaction
 *   - Double-tap anywhere on the Earth: that spot is selected and named.
 *   - Tap a pin or a row in the Places list: that place is selected.
 *   - Search (MMM-Keyboard) adds a pin; a tapped spot can be saved as a pin.
 *
 * Place panel: weather (Google Weather API), air quality (Google Air Quality
 * API), local time and headlines (Google News search). All lookups run in the
 * node_helper with the server key; nothing here holds that key.
 */
Module.register("MMM-GlobeWeatherBridge", {
	defaults: {
		renderer: "google3d", // "google3d" or "globegl"
		browserKey: "", // Google browser key, only for renderer "google3d"
		home: { label: "Home", address: "", lat: null, lng: null },
		autoLocate: true, // no address or coordinates set: find home from nearby Wi-Fi, then the internet connection
		pins: [],
		geocoder: "google", // search: "google" (SECRET_GOOGLE_MAPS_KEY) or "openmeteo"
		maxSearchResults: 5,
		units: config.units || "imperial",
		weatherRefreshMin: 30, // keeps the Weather API inside Google's free tier
		doubleTapMs: 450,
		// google3d camera ranges in meters (distance from the camera to the ground)
		globeRange: 16000000,
		placeRange: 1800000,
		flyMs: 2200,
		// globegl only
		autoRotate: true,
		autoRotateSpeed: 0.35,
		resumeRotateAfterMs: 45000,
		maxFps: 30,
		pixelRatio: 1,
		flyToAltitude: 1.4,
		globeImage: "earth-blue-marble.jpg",
		bumpImage: "earth-topology.png",
		backgroundImage: "night-sky.png",
		keyboardKey: "GWB_SEARCH"
	},

	getScripts () {
		return [this.file("vendor/globe.gl.min.js")];
	},

	getStyles () {
		return ["MMM-GlobeWeatherBridge.css"];
	},

	start () {
		this.places = { home: null, pins: [], userPins: [] };
		this.selected = null; // place shown in the panel
		this.info = null; // last GWB_INFO_RESULT for this.selected
		this.results = null;
		this.statusText = "";
		this.statusParts = {}; // "earth" | "home" | "misc" -> text; shown one per line
		this.requestSeq = 0;
		this.infoSeq = 0;
		this.globe = null;
		this.map3d = null;
		this.markers = [];
		this.lastTap = 0;
		this.sendSocketNotification("GWB_INIT", {
			home: this.config.home,
			pins: this.config.pins,
			autoLocate: this.config.autoLocate,
			geocoder: this.config.geocoder,
			maxSearchResults: this.config.maxSearchResults,
			units: this.config.units,
			weatherRefreshMin: this.config.weatherRefreshMin,
			language: config.language
		});
		this.refreshTimer = setInterval(() => {
			if (this.selected && !this.paused) this.requestInfo(this.selected, true);
		}, Math.max(5, this.config.weatherRefreshMin) * 60 * 1000);
		this.clockTimer = setInterval(() => this.renderClock(), 30 * 1000);
	},

	// ---------- DOM (built once, never replaced) ----------

	getDom () {
		if (this.root) return this.root;
		const root = document.createElement("div");
		root.className = "gwb-root";
		root.setAttribute("data-no-swipe", "");

		const stage = document.createElement("div");
		stage.className = "gwb-stage";
		this.earthEl = document.createElement("div");
		this.earthEl.className = "gwb-earth";
		stage.appendChild(this.earthEl);

		const toolbar = document.createElement("div");
		toolbar.className = "gwb-toolbar";
		toolbar.append(
			this.button("Search", () => this.openSearch()),
			this.button("Home", () => this.selectPlace(this.places.home)),
			this.button("Whole Earth", () => this.showWholeEarth())
		);
		stage.appendChild(toolbar);

		this.listEl = document.createElement("div");
		this.listEl.className = "gwb-list";
		stage.appendChild(this.listEl);

		this.hintEl = document.createElement("div");
		this.hintEl.className = "gwb-hint";
		this.hintEl.textContent = "Double-tap anywhere on the Earth to explore it";
		stage.appendChild(this.hintEl);

		this.statusEl = document.createElement("div");
		this.statusEl.className = "gwb-status";
		stage.appendChild(this.statusEl);

		this.panelEl = document.createElement("div");
		this.panelEl.className = "gwb-panel";

		root.append(stage, this.panelEl);
		this.root = root;
		this.renderList();
		this.renderPanel();
		return root;
	},

	button (label, onTap, extraClass) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "gwb-btn" + (extraClass ? " " + extraClass : "");
		btn.textContent = label;
		btn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			onTap();
		});
		return btn;
	},

	el (tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined && text !== null) e.textContent = text;
		return e;
	},

	allPlaces () {
		return [this.places.home, ...this.places.pins, ...this.places.userPins].filter(Boolean);
	},

	setStatus (text, key = "misc") {
		this.statusParts[key] = text || "";
		this.statusText = Object.values(this.statusParts).filter(Boolean).join("\n");
		if (this.statusEl) this.statusEl.textContent = this.statusText;
	},

	renderList () {
		if (!this.listEl) return;
		this.listEl.replaceChildren();
		this.listEl.appendChild(this.el("div", "gwb-list-title", this.results ? "Search results" : "Places"));
		const items = this.results || this.allPlaces();
		for (const place of items) {
			const row = this.el("button", "gwb-row" + (this.selected && place.id === this.selected.id ? " gwb-selected" : ""));
			row.type = "button";
			row.appendChild(this.el("span", "gwb-row-name", place.label));
			if (place.address) row.appendChild(this.el("span", "gwb-row-sub", place.address));
			row.addEventListener("click", () => (this.results ? this.pickResult(place) : this.selectPlace(place)));
			this.listEl.appendChild(row);
		}
		if (this.results) {
			this.listEl.appendChild(this.button("Cancel", () => {
				this.results = null;
				this.renderList();
			}, "gwb-btn-small"));
		} else if (items.length === 0) {
			this.listEl.appendChild(this.el("div", "gwb-row-sub", "No places yet. Set home in the admin page, search, or double-tap the Earth."));
		}
	},

	// ---------- place panel ----------

	timeIn (zone, opts) {
		try {
			return new Date().toLocaleString("en-US", Object.assign({ timeZone: zone }, opts));
		} catch {
			return "";
		}
	},

	renderClock () {
		if (!this.clockEl || !this.info || !this.info.timeZone || this.paused) return;
		const zone = this.info.timeZone;
		const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const time = this.timeIn(zone, { hour: "numeric", minute: "2-digit" });
		const day = this.timeIn(zone, { weekday: "long" });
		this.clockEl.textContent = time + ", " + day + (zone !== here ? " (local time)" : "");
	},

	renderPanel () {
		const panel = this.panelEl;
		if (!panel) return;
		panel.replaceChildren();
		const place = this.selected;
		if (!place) {
			panel.appendChild(this.el("div", "gwb-panel-empty", this.places.home ? "Pick a place." : "Finding home…"));
			return;
		}
		const info = this.info && this.info.requestId === this.infoSeq ? this.info : null;
		const head = this.el("div", "gwb-head");
		head.appendChild(this.el("div", "gwb-place", info ? info.place.label || place.label : place.label));
		const areaText = info && info.place.area ? info.place.area : place.kind === "tap" ? "" : place.address || "";
		if (areaText) head.appendChild(this.el("div", "gwb-area", areaText));
		this.clockEl = this.el("div", "gwb-clock");
		head.appendChild(this.clockEl);
		panel.appendChild(head);

		const actions = this.el("div", "gwb-actions");
		if (place.kind === "tap") {
			actions.appendChild(this.button("Save as pin", () => {
				const label = info ? info.place.label : "Pin";
				this.setStatus("Saving pin…");
				this.sendSocketNotification("GWB_ADD_PIN_HERE", { lat: place.lat, lng: place.lng, label, address: info ? info.place.area : "" });
			}, "gwb-btn-small"));
		} else if (place.kind === "user") {
			actions.appendChild(this.button("Remove pin", () => {
				this.sendSocketNotification("GWB_REMOVE_PIN", { id: place.id });
				this.selectPlace(this.places.home);
			}, "gwb-btn-small gwb-danger"));
		}
		if (actions.childNodes.length) panel.appendChild(actions);

		if (!info) {
			panel.appendChild(this.el("div", "gwb-loading", "Looking up weather and news…"));
			return;
		}
		this.renderClock();
		panel.appendChild(this.weatherSection(info));
		const sun = this.sunSection(info);
		if (sun) panel.appendChild(sun);
		panel.appendChild(this.airSection(info));
		if (info.about) panel.appendChild(this.aboutSection(info));
		if (info.nearby && info.nearby.length) panel.appendChild(this.nearbySection(info));
		if (info.country) panel.appendChild(this.countrySection(info));
		panel.appendChild(this.newsSection(info));
		panel.appendChild(this.el("div", "gwb-credit", "Weather and air quality: Google. Headlines: Google News. About, nearby and country: Wikipedia and Wikidata (CC BY-SA)."));
	},

	section (title) {
		const s = this.el("section", "gwb-section");
		s.appendChild(this.el("h4", "gwb-section-title", title));
		return s;
	},

	/* Ink drawn icons (no fonts, no network): sun, moon phase, cloud,
	 * sunrise, sunset. Used for the sun and moon section and as the fallback
	 * when a Google weather icon cannot load. */
	inkIcon (kind, cls, moonPhase) {
		const wrap = this.el("span", "gwb-ink " + (cls || "gwb-wx-icon"));
		const rays = (cx, cy, r1, r2, from, to) => {
			let d = "";
			for (let a = from; a <= to; a += 45) {
				const t = (a * Math.PI) / 180;
				d += "M" + (cx + r1 * Math.cos(t)).toFixed(1) + " " + (cy - r1 * Math.sin(t)).toFixed(1) + "L" + (cx + r2 * Math.cos(t)).toFixed(1) + " " + (cy - r2 * Math.sin(t)).toFixed(1);
			}
			return "<path d=\"" + d + "\"/>";
		};
		let body = "";
		if (kind === "sun") {
			body = "<circle cx=\"12\" cy=\"12\" r=\"4.5\"/>" + rays(12, 12, 7, 10, 0, 315);
		} else if (kind === "sunrise" || kind === "sunset") {
			const arrow = kind === "sunrise" ? "M12 3v5M9.5 5.5 12 3l2.5 2.5" : "M12 3v5M9.5 5.5 12 8l2.5-2.5";
			body = "<path d=\"M7 17a5 5 0 0 1 10 0\"/>" + rays(12, 17, 7, 9.5, 0, 180) + "<path d=\"M3 20h18\"/><path d=\"" + arrow + "\"/>";
		} else if (kind === "cloud") {
			body = "<path d=\"M7 18h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18z\"/>";
		} else if (kind === "moon") {
			// Lit part drawn over a dark disc: k = lit fraction, right side lit while waxing.
			const phases = { NEW_MOON: [0, 1], WAXING_CRESCENT: [0.25, 1], FIRST_QUARTER: [0.5, 1], WAXING_GIBBOUS: [0.75, 1], FULL_MOON: [1, 1], WANING_GIBBOUS: [0.75, 0], LAST_QUARTER: [0.5, 0], WANING_CRESCENT: [0.25, 0] };
			const [k, right] = phases[moonPhase] || [0.5, 1];
			const r = 9;
			const rx = Math.abs(1 - 2 * k) * r;
			const outer = right ? 1 : 0;
			const inner = k < 0.5 ? (right ? 0 : 1) : (right ? 1 : 0);
			const lit = k <= 0 ? "" : k >= 1 ? "<circle class=\"gwb-lit\" cx=\"12\" cy=\"12\" r=\"9\"/>"
				: "<path class=\"gwb-lit\" d=\"M12 3A9 9 0 0 " + outer + " 12 21A" + rx.toFixed(2) + " 9 0 0 " + inner + " 12 3z\"/>";
			body = "<circle class=\"gwb-dark\" cx=\"12\" cy=\"12\" r=\"9\"/>" + lit;
		}
		wrap.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\">" + body + "</svg>";
		return wrap;
	},

	/** A rough ink icon for a weather description, when Google's icon is missing. */
	fallbackKind (text) {
		return /clear|sunny|fair/i.test(String(text || "")) ? "sun" : "cloud";
	},

	weatherIcon (url, cls, text) {
		if (!url) return this.inkIcon(this.fallbackKind(text), cls);
		const img = this.el("img", cls || "gwb-wx-icon");
		img.alt = "";
		img.src = url;
		img.addEventListener("error", () => img.replaceWith(this.inkIcon(this.fallbackKind(text), cls)));
		return img;
	},

	weatherSection (info) {
		const s = this.section("Weather");
		if (!info.weather) {
			s.appendChild(this.el("div", "gwb-error", info.weatherError || "No weather data."));
			return s;
		}
		const { current: c, hours, days } = info.weather;
		const now = this.el("div", "gwb-now");
		now.appendChild(this.weatherIcon(c.icon, "gwb-now-icon", c.text));
		const big = this.el("div", "gwb-now-main");
		big.appendChild(this.el("div", "gwb-now-temp", (c.temp ?? "–") + c.unit));
		big.appendChild(this.el("div", "gwb-now-text", c.text));
		now.appendChild(big);
		s.appendChild(now);

		const facts = this.el("div", "gwb-facts");
		const fact = (label, value) => {
			if (value === null || value === undefined || value === "") return;
			const f = this.el("div", "gwb-fact");
			f.append(this.el("span", "gwb-fact-label", label), this.el("span", "gwb-fact-value", value));
			facts.appendChild(f);
		};
		fact("Feels like", c.feels !== null ? c.feels + "°" : "");
		fact("High / low", c.high !== null && c.low !== null ? c.high + "° / " + c.low + "°" : "");
		fact("Rain", c.rain !== null ? c.rain + "%" : "");
		fact("Humidity", c.humidity !== null ? c.humidity + "%" : "");
		fact("Wind", c.wind !== null ? c.wind + " " + c.windUnit + (c.windFrom ? " " + c.windFrom : "") : "");
		fact("UV index", c.uv !== null ? String(c.uv) : "");
		s.appendChild(facts);

		if (hours && hours.length) {
			const row = this.el("div", "gwb-hours");
			for (const h of hours.slice(0, 6)) {
				const cell = this.el("div", "gwb-hour");
				const hr = h.hour === null ? "" : (h.hour % 12 || 12) + (h.hour < 12 ? "a" : "p");
				cell.append(this.el("span", "gwb-hour-time", hr), this.weatherIcon(h.icon, null, h.text), this.el("span", "gwb-hour-temp", (h.temp ?? "–") + "°"));
				if (h.rain) cell.appendChild(this.el("span", "gwb-hour-rain", h.rain + "%"));
				row.appendChild(cell);
			}
			s.appendChild(row);
		}

		if (days && days.length) {
			const lows = days.map((d) => d.low).filter(Number.isFinite);
			const highs = days.map((d) => d.high).filter(Number.isFinite);
			const min = Math.min(...lows);
			const max = Math.max(...highs);
			const list = this.el("div", "gwb-days");
			days.forEach((d, i) => {
				const row = this.el("div", "gwb-day");
				const name = i === 0 ? "Today" : d.date ? new Date(d.date.y, d.date.m - 1, d.date.d).toLocaleDateString("en-US", { weekday: "short" }) : "";
				row.appendChild(this.el("span", "gwb-day-name", name));
				row.appendChild(this.weatherIcon(d.icon, null, d.text));
				row.appendChild(this.el("span", "gwb-day-rain", d.rain ? d.rain + "%" : ""));
				row.appendChild(this.el("span", "gwb-day-low", (d.low ?? "–") + "°"));
				const bar = this.el("span", "gwb-day-bar");
				const fill = this.el("span", "gwb-day-fill");
				if (Number.isFinite(d.low) && Number.isFinite(d.high) && max > min) {
					fill.style.left = ((d.low - min) / (max - min)) * 100 + "%";
					fill.style.right = (100 - ((d.high - min) / (max - min)) * 100) + "%";
				}
				bar.appendChild(fill);
				row.appendChild(bar);
				row.appendChild(this.el("span", "gwb-day-high", (d.high ?? "–") + "°"));
				list.appendChild(row);
			});
			s.appendChild(list);
		}
		return s;
	},

	sunSection (info) {
		const today = info.weather && info.weather.days && info.weather.days[0];
		if (!today || (!today.sunrise && !today.moonPhase)) return null;
		const s = this.section("Sun and moon");
		const zone = info.timeZone || undefined;
		const t = (iso) => {
			try {
				return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
			} catch {
				return "";
			}
		};
		const row = this.el("div", "gwb-sun");
		const item = (icon, label, value) => {
			if (!value) return;
			const f = this.el("div", "gwb-sun-item");
			const txt = this.el("div", "");
			txt.append(this.el("div", "gwb-fact-label", label), this.el("div", "gwb-fact-value", value));
			f.append(icon, txt);
			row.appendChild(f);
		};
		if (today.sunrise) item(this.inkIcon("sunrise", "gwb-sun-icon"), "Sunrise", t(today.sunrise));
		if (today.sunset) item(this.inkIcon("sunset", "gwb-sun-icon"), "Sunset", t(today.sunset));
		if (today.sunrise && today.sunset) {
			const mins = Math.round((Date.parse(today.sunset) - Date.parse(today.sunrise)) / 60000);
			if (mins > 0) item(this.inkIcon("sun", "gwb-sun-icon"), "Daylight", Math.floor(mins / 60) + " h " + (mins % 60) + " min");
		}
		if (today.moonPhase) {
			const name = today.moonPhase.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
			item(this.inkIcon("moon", "gwb-sun-icon", today.moonPhase), "Moon", name);
		}
		s.appendChild(row);
		return s;
	},

	aboutSection (info) {
		const a = info.about;
		const s = this.section("About " + a.title);
		if (a.image) {
			const img = this.el("img", "gwb-about-img");
			img.src = a.image;
			img.alt = a.title;
			img.addEventListener("error", () => img.remove());
			s.appendChild(img);
		}
		if (a.description) s.appendChild(this.el("div", "gwb-about-desc", a.description));
		s.appendChild(this.el("p", "gwb-about-text", a.extract));
		return s;
	},

	nearbySection (info) {
		const s = this.section("Nearby");
		const list = this.el("div", "gwb-nearby");
		for (const n of info.nearby) {
			const b = this.el("button", "gwb-near");
			b.type = "button";
			const dist = n.meters >= 1000 ? (n.meters / 1609.34).toFixed(1) + " mi" : Math.round(n.meters * 3.281) + " ft";
			b.append(this.el("span", "gwb-near-name", n.title), this.el("span", "gwb-near-dist", dist));
			b.addEventListener("click", () => this.selectPlace({ id: "tap:" + n.lat.toFixed(4) + "," + n.lng.toFixed(4), kind: "tap", named: true, label: n.title, address: "", lat: n.lat, lng: n.lng }));
			list.appendChild(b);
		}
		s.appendChild(list);
		return s;
	},

	countrySection (info) {
		const c = info.country;
		const s = this.section("Country");
		s.appendChild(this.el("div", "gwb-country-name", (c.flag ? c.flag + "  " : "") + c.name));
		const facts = this.el("div", "gwb-facts");
		const fact = (label, value) => {
			if (!value) return;
			const f = this.el("div", "gwb-fact");
			f.append(this.el("span", "gwb-fact-label", label), this.el("span", "gwb-fact-value", value));
			facts.appendChild(f);
		};
		fact("Capital", c.capital);
		fact("Population", c.population ? (c.population >= 1e6 ? (c.population / 1e6).toFixed(c.population >= 1e8 ? 0 : 1) + " million" : c.population.toLocaleString("en-US")) : "");
		fact("Currency", c.currencies.join(", "));
		fact(c.languages.length > 1 ? "Languages" : "Language", c.languages.join(", "));
		s.appendChild(facts);
		return s;
	},

	airSection (info) {
		const s = this.section("Air quality");
		if (!info.air) {
			s.appendChild(this.el("div", "gwb-error", info.airError || "No air quality data here."));
			return s;
		}
		const a = info.air;
		const row = this.el("div", "gwb-air");
		const dot = this.el("span", "gwb-air-dot");
		dot.style.background = a.color;
		row.append(dot, this.el("span", "gwb-air-aqi", a.aqi), this.el("span", "gwb-air-cat", a.category));
		s.appendChild(row);
		s.appendChild(this.el("div", "gwb-air-sub", a.name + (a.dominant ? ". Main pollutant: " + a.dominant : "")));
		return s;
	},

	ago (iso) {
		const ms = Date.now() - Date.parse(iso);
		if (!Number.isFinite(ms) || ms < 0) return "";
		const min = Math.round(ms / 60000);
		if (min < 60) return min + " min ago";
		const h = Math.round(min / 60);
		if (h < 48) return h + " h ago";
		return Math.round(h / 24) + " days ago";
	},

	newsSection (info) {
		const s = this.section(info.newsQuery ? "News: " + info.newsQuery : "News");
		if (info.newsError) {
			s.appendChild(this.el("div", "gwb-error", info.newsError));
			return s;
		}
		if (!info.news || !info.news.length) {
			s.appendChild(this.el("div", "gwb-error", "No headlines for this place."));
			return s;
		}
		const list = this.el("ol", "gwb-news");
		for (const n of info.news) {
			const li = this.el("li", "gwb-news-item");
			li.appendChild(this.el("div", "gwb-news-title", n.title));
			li.appendChild(this.el("div", "gwb-news-meta", [n.source, n.published ? this.ago(n.published) : ""].filter(Boolean).join(", ")));
			list.appendChild(li);
		}
		s.appendChild(list);
		return s;
	},

	// ---------- earth: start ----------

	initEarth () {
		if (this.earthStarted || !this.earthEl) return;
		this.earthStarted = true;
		const key = String(this.config.browserKey || "");
		const keyOk = key && !key.includes("${") && !key.startsWith("**");
		if (this.config.renderer === "google3d" && keyOk) {
			this.renderer = "google3d";
			this.initGoogle(key).catch((err) => this.googleFailed(err.message));
		} else {
			if (this.config.renderer === "google3d") this.setStatus("Google 3D Earth needs GOOGLE_MAPS_BROWSER_KEY in config.env. Showing the simple globe.", "earth");
			this.initGlobeGl();
		}
	},

	googleFailed (why) {
		if (this.renderer === "globegl") return; // already fell back
		this.renderer = "globegl";
		Log.error("MMM-GlobeWeatherBridge: Google 3D Earth unavailable: " + why);
		if (this.map3d) this.map3d.remove();
		this.map3d = null;
		this.markers = [];
		this.setStatus("Google 3D Earth unavailable (" + why + "). Showing the simple globe.", "earth");
		this.initGlobeGl();
	},

	/* Google reports key problems only as a console error ("Google Maps
	 * JavaScript API error: InvalidKeyMapError"); the 3D map does not call
	 * gm_authFailure (seen with maps3d, weekly channel, October 2026). */
	watchMapsErrors () {
		if (this.consoleHooked) return;
		this.consoleHooked = true;
		const reasons = {
			InvalidKeyMapError: "GOOGLE_MAPS_BROWSER_KEY is not a valid key",
			RefererNotAllowedMapError: "the browser key does not allow http://localhost:8080/* (Websites restriction)",
			ApiNotActivatedMapError: "Maps JavaScript API is not enabled for the browser key",
			ApiTargetBlockedMapError: "the browser key's API restrictions block Maps JavaScript API or Map Tiles API",
			BillingNotEnabledMapError: "billing is not enabled on the Google Cloud project"
		};
		const original = console.error;
		console.error = (...args) => {
			original.apply(console, args);
			const m = /Google Maps JavaScript API error: (\w+)/.exec(String(args[0]));
			if (m && this.renderer === "google3d") this.googleFailed(reasons[m[1]] || m[1]);
		};
	},

	/** Load the Maps JavaScript API once. Never called again for this page. */
	loadMapsApi (key) {
		if (window.google && window.google.maps && window.google.maps.importLibrary) return Promise.resolve();
		this.watchMapsErrors();
		return new Promise((resolve, reject) => {
			window.__gwbMapsReady = () => resolve();
			window.gm_authFailure = () => this.googleFailed("the browser key was rejected: check its referrer (http://localhost:8080/*) and API restrictions");
			const s = document.createElement("script");
			s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&v=weekly&libraries=maps3d&loading=async&callback=__gwbMapsReady";
			s.async = true;
			s.onerror = () => reject(new Error("could not load Google Maps (no internet?)"));
			document.head.appendChild(s);
			setTimeout(() => reject(new Error("Google Maps did not load within 30 s")), 30000);
		});
	},

	async initGoogle (key) {
		await this.loadMapsApi(key);
		const { Map3DElement } = await google.maps.importLibrary("maps3d");
		const home = this.places.home;
		const map = new Map3DElement({
			center: { lat: home ? home.lat : 20, lng: home ? home.lng : 0, altitude: 0 },
			range: this.config.globeRange,
			tilt: 0,
			heading: 0,
			mode: "HYBRID",
			defaultUIHidden: true
		});
		map.classList.add("gwb-map3d");
		map.addEventListener("gmp-error", () => this.googleFailed("the map reported an error"));
		// Watchdog: a map that never settles (blocked key, no GPU, no internet)
		// falls back. Only time with the globe page ON SCREEN counts: at boot the
		// fridge shows the Home page, and a hidden map cannot finish drawing, so
		// a plain timer gave up before anyone looked (seen on the Pi, 2026-10-05).
		// A Pi 4 needs a while to draw the first view, so it gets a visible minute.
		let settled = false;
		let visibleMs = 0;
		map.addEventListener("gmp-steadychange", (ev) => {
			if (ev.isSteady !== false) settled = true;
		});
		const watchdog = setInterval(() => {
			if (settled || this.map3d !== map) {
				clearInterval(watchdog);
				return;
			}
			if (!this.paused) visibleMs += 1000;
			if (visibleMs >= 60000) {
				clearInterval(watchdog);
				this.googleFailed("it did not finish loading after a minute on screen; is the GPU off (MM_DISABLE_GPU)?");
			}
		}, 1000);
		map.addEventListener("gmp-click", (ev) => {
			const pos = ev.position;
			if (pos) this.tapAt(pos.lat, pos.lng);
		});
		if (this.renderer !== "google3d") return; // failed while loading
		this.earthEl.appendChild(map);
		this.map3d = map;
		this.refreshPins();
	},

	/** Two taps within doubleTapMs select the spot under the finger. */
	tapAt (lat, lng) {
		const now = Date.now();
		if (now - this.lastTap < this.config.doubleTapMs) {
			this.lastTap = 0;
			this.selectSpot(lat, lng);
		} else {
			this.lastTap = now;
		}
	},

	flyTo (lat, lng, far) {
		if (this.map3d) {
			this.map3d.stopCameraAnimation();
			this.map3d.flyCameraTo({
				endCamera: { center: { lat, lng, altitude: 0 }, range: far ? this.config.globeRange : this.config.placeRange, tilt: 0, heading: 0 },
				durationMillis: this.config.flyMs
			});
		} else if (this.globe) {
			this.holdRotation();
			this.globe.pointOfView({ lat, lng, altitude: far ? 2.4 : this.config.flyToAltitude }, this.config.flyMs);
		}
	},

	showWholeEarth () {
		const c = this.selected || this.places.home || { lat: 20, lng: 0 };
		this.flyTo(c.lat, c.lng, true);
	},

	// ---------- earth: globe.gl fallback ----------

	initGlobeGl () {
		if (this.globe) return;
		this.renderer = "globegl";
		if (typeof Globe !== "function") {
			this.setStatus("Globe library missing. Run install.sh (fetch-globe-assets) on the Pi.", "earth");
			return;
		}
		try {
			const img = (name) => (name ? this.file("vendor/img/" + name) : null);
			const globe = Globe({ rendererConfig: { antialias: false, alpha: false, powerPreference: "low-power" }, animateIn: false })(this.earthEl);
			globe
				.globeImageUrl(img(this.config.globeImage))
				.bumpImageUrl(img(this.config.bumpImage))
				.backgroundImageUrl(img(this.config.backgroundImage))
				.backgroundColor("#000000")
				.showAtmosphere(true)
				.atmosphereColor("#9fc3e6")
				.atmosphereAltitude(0.15)
				.enablePointerInteraction(false)
				.htmlElementsData([])
				.htmlLat((d) => d.lat)
				.htmlLng((d) => d.lng)
				.htmlAltitude(0.01)
				.htmlElement((d) => this.pinElement(d))
				.htmlElementVisibilityModifier((el, visible) => {
					el.style.opacity = visible ? "1" : "0";
					el.style.pointerEvents = visible ? "auto" : "none";
				});
			globe.renderer().setPixelRatio(this.config.pixelRatio);
			const controls = globe.controls();
			controls.autoRotate = this.config.autoRotate;
			controls.autoRotateSpeed = this.config.autoRotateSpeed;
			controls.enablePan = false;
			controls.minDistance = 130;
			controls.maxDistance = 600;
			let down = null;
			this.earthEl.addEventListener("pointerdown", (ev) => {
				this.holdRotation();
				down = { x: ev.clientX, y: ev.clientY };
			});
			this.earthEl.addEventListener("pointerup", (ev) => {
				if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 12) return;
				const rect = this.earthEl.getBoundingClientRect();
				const at = globe.toGlobeCoords(ev.clientX - rect.left, ev.clientY - rect.top);
				if (at) this.tapAt(at.lat, at.lng);
			});
			this.globe = globe;
			this.resize();
			this.resizeObserver = new ResizeObserver(() => this.resize());
			this.resizeObserver.observe(this.earthEl);
			this.refreshPins();
			if (this.places.home) globe.pointOfView({ lat: this.places.home.lat, lng: this.places.home.lng, altitude: 2.2 }, 0);
			this.startLoop();
			if (this.paused) this.stopLoop();
		} catch (err) {
			Log.error("MMM-GlobeWeatherBridge: globe init failed: " + err.message);
			this.setStatus("3D globe unavailable (" + err.message + "). Use the Places list.", "earth");
			this.globe = null;
		}
	},

	resize () {
		if (!this.globe || !this.earthEl) return;
		const rect = this.earthEl.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) this.globe.width(rect.width).height(rect.height);
	},

	/* Frame rate cap: resume+pause back to back renders exactly one frame. */
	startLoop () {
		if (!this.globe) return;
		this.stopLoop();
		if (this.config.maxFps >= 60) {
			this.globe.resumeAnimation();
			return;
		}
		this.globe.pauseAnimation();
		this.frameTimer = setInterval(() => {
			this.globe.resumeAnimation();
			this.globe.pauseAnimation();
		}, Math.round(1000 / Math.max(1, this.config.maxFps)));
	},

	stopLoop () {
		clearInterval(this.frameTimer);
		this.frameTimer = null;
		if (this.globe) this.globe.pauseAnimation();
	},

	holdRotation () {
		if (!this.globe) return;
		const controls = this.globe.controls();
		controls.autoRotate = false;
		clearTimeout(this.rotateTimer);
		if (this.config.autoRotate) {
			this.rotateTimer = setTimeout(() => {
				controls.autoRotate = true;
			}, this.config.resumeRotateAfterMs);
		}
	},

	pinElement (place) {
		const el = this.el("div", "gwb-pin gwb-pin-" + place.kind + (this.selected && place.id === this.selected.id ? " gwb-pin-selected" : ""));
		el.append(this.el("div", "gwb-pin-dot"), this.el("div", "gwb-pin-label", place.label));
		el.style.pointerEvents = "auto";
		el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
		el.addEventListener("click", (ev) => {
			ev.stopPropagation();
			this.selectPlace(this.allPlaces().find((p) => p.id === place.id) || place);
		});
		return el;
	},

	async refreshPins () {
		const shown = this.allPlaces();
		if (this.selected && this.selected.kind === "tap") shown.push(this.selected);
		if (this.globe) this.globe.htmlElementsData(shown.map((p) => Object.assign({}, p)));
		if (!this.map3d) return;
		const { Marker3DInteractiveElement } = await google.maps.importLibrary("maps3d");
		for (const m of this.markers) m.remove();
		this.markers = shown.map((p) => {
			const m = new Marker3DInteractiveElement({ position: { lat: p.lat, lng: p.lng }, label: p.label, altitudeMode: "CLAMP_TO_GROUND" });
			m.addEventListener("gmp-click", (ev) => {
				ev.stopPropagation();
				this.selectPlace(this.allPlaces().find((x) => x.id === p.id) || p);
			});
			this.map3d.appendChild(m);
			return m;
		});
	},

	// ---------- actions ----------

	requestInfo (place, refresh) {
		if (!refresh) this.infoSeq += 1;
		this.sendSocketNotification("GWB_INFO", { requestId: this.infoSeq, lat: place.lat, lng: place.lng, label: place.kind === "tap" && !place.named ? "" : place.label, kind: place.kind });
	},

	selectPlace (place) {
		if (!place) return;
		this.selected = place;
		this.info = null;
		this.results = null;
		this.requestInfo(place);
		this.flyTo(place.lat, place.lng, false);
		this.setStatus("");
		this.renderList();
		this.renderPanel();
		this.refreshPins();
	},

	selectSpot (lat, lng) {
		if (this.hintEl) this.hintEl.classList.add("gwb-hidden");
		this.selectPlace({ id: "tap:" + lat.toFixed(4) + "," + lng.toFixed(4), kind: "tap", label: "Selected spot", address: "", lat, lng });
	},

	openSearch () {
		this.sendNotification("KEYBOARD", { key: this.config.keyboardKey, style: "default", data: {}, sendLabel: "Search" });
	},

	pickResult (result) {
		this.pendingSelect = { lat: result.lat, lng: result.lng };
		this.results = null;
		this.setStatus("Adding pin…");
		this.renderList();
		this.sendSocketNotification("GWB_ADD_PIN", result);
	},

	notificationReceived (notification, payload) {
		if (notification === "DOM_OBJECTS_CREATED") {
			// Defer so the region has its final size.
			setTimeout(() => this.initEarth(), 500);
		} else if (notification === "KEYBOARD_INPUT" && payload && payload.key === this.config.keyboardKey) {
			const query = String(payload.message || "").trim();
			if (query.length < 2) return;
			this.requestSeq += 1;
			this.setStatus("Searching for “" + query + "”…");
			this.sendSocketNotification("GWB_SEARCH", { query, requestId: this.requestSeq });
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "GWB_STATE") {
			const hadHome = Boolean(this.places.home);
			this.places = { home: payload.home, pins: payload.pins || [], userPins: payload.userPins || [] };
			if (this.pendingSelect) {
				const target = this.places.userPins.find((p) => Math.abs(p.lat - this.pendingSelect.lat) < 1e-4 && Math.abs(p.lng - this.pendingSelect.lng) < 1e-4);
				this.pendingSelect = null;
				if (target) {
					this.selectPlace(target);
					return;
				}
			}
			this.setStatus(this.places.home ? "" : "Home could not be found. Set the home address in the admin page (Globe home and pins).", "home");
			// A selected pin that was removed falls back to home.
			if (this.selected && this.selected.kind !== "tap" && !this.allPlaces().some((p) => p.id === this.selected.id)) this.selected = null;
			if (!this.selected && this.places.home) {
				this.selectPlace(this.places.home);
				if (!hadHome) this.flyTo(this.places.home.lat, this.places.home.lng, true);
				return;
			}
			this.renderList();
			this.refreshPins();
		} else if (notification === "GWB_PIN_SAVED") {
			const pin = this.places.userPins.find((p) => p.id === payload.id);
			this.setStatus("");
			if (pin) {
				this.selected = pin;
				this.renderList();
				this.renderPanel();
				this.refreshPins();
			}
		} else if (notification === "GWB_INFO_RESULT") {
			if (payload.requestId !== this.infoSeq) return; // an older place
			this.info = payload;
			if (this.selected && this.selected.kind === "tap" && !this.selected.named && payload.place.label) {
				this.selected = Object.assign({}, this.selected, { label: payload.place.label });
				this.refreshPins();
			}
			this.renderPanel();
		} else if (notification === "GWB_SEARCH_RESULTS") {
			if (payload.requestId !== this.requestSeq) return; // stale answer
			if (payload.error) {
				this.setStatus("Search failed: " + payload.error);
				return;
			}
			if (!payload.results || payload.results.length === 0) {
				this.setStatus("No results for “" + (payload.query || "") + "”");
				return;
			}
			this.setStatus("Tap a result to pin it.");
			this.results = payload.results.map((r, i) => Object.assign({ id: "result:" + i, kind: "result" }, r));
			this.renderList();
		}
	},

	/* MMM-pages hides other pages by making them transparent, not by removing
	 * them, so Google's 3D map kept drawing with the GPU on every page. On a
	 * Pi 4 that load made the whole screen flicker (2026-10-07). display:none
	 * takes the Earth out of layout, so neither map draws while hidden. */
	suspend () {
		this.paused = true;
		this.stopLoop();
		if (this.earthEl) this.earthEl.style.display = "none";
	},

	resume () {
		this.paused = false;
		if (this.earthEl) this.earthEl.style.display = "";
		if (this.globe) {
			this.resize();
			this.startLoop();
		}
		this.renderClock();
	}
});
