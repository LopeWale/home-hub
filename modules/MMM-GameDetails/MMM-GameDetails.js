/* MMM-GameDetails
 *
 * Right panel of the Sports page. Tap a game in MMM-MyScoreboard (patched to
 * tag each game with its ESPN id) and its details show here in tabs:
 * Overview (win chance, line, venue, team stats), Plays (scoring), Players
 * (leaders, soccer lineups), Injuries, Table (standings) and News. With no game
 * tapped it follows a live game, else the first game listed.
 */
Module.register("MMM-GameDetails", {
	defaults: {
		liveRefreshMs: 30 * 1000,
		refreshMs: 5 * 60 * 1000
	},

	getStyles () {
		return ["MMM-GameDetails.css"];
	},

	start () {
		this.selected = null; // { gameId, espnPath, league, picked: bool }
		this.game = null;
		this.error = null;
		this.tab = "overview";
		this.logos = new Map(); // logo URL -> <img>, reused so a refresh does not reload them
		document.addEventListener("click", (ev) => {
			const box = ev.target.closest && ev.target.closest(".MMM-MyScoreboard .box-score[data-game-id]");
			if (!box) return;
			this.select({ gameId: box.dataset.gameId, espnPath: box.dataset.espnPath, league: box.dataset.league, picked: true });
		}, true);
	},

	notificationReceived (notification) {
		if (notification === "DOM_OBJECTS_CREATED") {
			// The scoreboard redraws itself every couple of minutes; keep the
			// highlight and the automatic pick in step with it.
			const sb = document.querySelector(".module.MMM-MyScoreboard");
			if (sb) new MutationObserver(() => this.onScoreboardChanged()).observe(sb, { childList: true, subtree: true });
			this.onScoreboardChanged();
		}
	},

	boxes () {
		return Array.from(document.querySelectorAll(".MMM-MyScoreboard .box-score[data-game-id]"));
	},

	onScoreboardChanged () {
		clearTimeout(this.sbTimer);
		this.sbTimer = setTimeout(() => {
			const boxes = this.boxes();
			const still = this.selected && boxes.some((b) => b.dataset.gameId === this.selected.gameId);
			if (!still || !this.selected.picked) {
				const pick = boxes.find((b) => b.classList.contains("in-progress")) || boxes[0];
				if (pick && (!this.selected || pick.dataset.gameId !== this.selected.gameId)) {
					this.select({ gameId: pick.dataset.gameId, espnPath: pick.dataset.espnPath, league: pick.dataset.league, picked: false });
					return;
				}
				if (!pick && this.selected) {
					this.selected = null;
					this.render();
				}
			}
			this.highlight();
		}, 300);
	},

	highlight () {
		for (const b of this.boxes()) b.classList.toggle("gd-selected", Boolean(this.selected) && b.dataset.gameId === this.selected.gameId);
	},

	select (sel) {
		const changed = !this.selected || this.selected.gameId !== sel.gameId;
		this.selected = sel;
		if (changed) {
			this.game = null;
			this.error = null;
			this.tab = "overview";
		}
		this.highlight();
		this.render();
		this.fetch();
	},

	fetch () {
		clearTimeout(this.refreshTimer);
		if (!this.selected || this.paused) return;
		this.sendSocketNotification("GD_GET", { gameId: this.selected.gameId, espnPath: this.selected.espnPath });
		const live = this.game && this.game.state === "in";
		this.refreshTimer = setTimeout(() => this.fetch(), live ? this.config.liveRefreshMs : this.config.refreshMs);
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "GD_DATA" || !this.selected || payload.gameId !== this.selected.gameId) return;
		// During a live game this arrives every 30 s; redraw only when something changed.
		const key = JSON.stringify([payload.data || this.game, payload.error || null]);
		if (key === this.lastKey) return;
		this.lastKey = key;
		this.game = payload.data || this.game;
		this.error = payload.error || null;
		this.render();
	},

	suspend () {
		this.paused = true;
		clearTimeout(this.refreshTimer);
	},

	resume () {
		this.paused = false;
		this.onScoreboardChanged();
		this.fetch();
	},

	// ---------- DOM ----------

	el (tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined && text !== null) e.textContent = text;
		return e;
	},

	getDom () {
		if (!this.root) {
			this.root = this.el("div", "gd-root");
			this.root.setAttribute("data-no-swipe", "");
		}
		this.render();
		return this.root;
	},

	tabsFor (d) {
		const tabs = [["overview", "Overview"]];
		if (d.scoring && d.scoring.length) tabs.push(["plays", "Plays"]);
		if ((d.leaders && d.leaders.length) || (d.lineups && d.lineups.length)) tabs.push(["players", d.lineups && d.lineups.length ? "Lineups" : "Players"]);
		if (d.injuries && d.injuries.length) tabs.push(["injuries", "Injuries"]);
		if (d.standings && d.standings.length) tabs.push(["table", "Table"]);
		if (d.news && d.news.length) tabs.push(["news", "News"]);
		return tabs;
	},

	render () {
		if (!this.root) return;
		const root = this.root;
		// Keep the reader's place in a long list (plays, lineups) across live refreshes.
		const oldBody = root.querySelector(".gd-body");
		const keepScroll = oldBody && this.renderedTab === this.tab ? oldBody.scrollTop : 0;
		this.renderedTab = this.tab;
		root.replaceChildren();
		if (!this.selected) {
			root.appendChild(this.el("div", "gd-empty", "Tap a game on the left for its details."));
			return;
		}
		const d = this.game;
		if (!d) {
			root.appendChild(this.el("div", "gd-empty", this.error || "Loading game details…"));
			return;
		}
		root.appendChild(this.header(d));
		const tabs = this.tabsFor(d);
		if (!tabs.some(([id]) => id === this.tab)) this.tab = "overview";
		const bar = this.el("div", "gd-tabs");
		for (const [id, label] of tabs) {
			const b = this.el("button", "gd-tab" + (id === this.tab ? " gd-tab-on" : ""), label);
			b.type = "button";
			b.addEventListener("click", () => {
				this.tab = id;
				this.render();
			});
			bar.appendChild(b);
		}
		root.appendChild(bar);
		const body = this.el("div", "gd-body");
		const draw = { overview: this.overview, plays: this.plays, players: this.players, injuries: this.injuries, table: this.table, news: this.newsTab }[this.tab];
		draw.call(this, body, d);
		root.appendChild(body);
		if (keepScroll) body.scrollTop = keepScroll;
		if (this.error) root.appendChild(this.el("div", "gd-note", this.error + " Showing the last details."));
	},

	header (d) {
		const h = this.el("div", "gd-head");
		const teamEl = (t) => {
			const w = this.el("div", "gd-team" + (t.winner ? " gd-winner" : ""));
			if (t.logo) {
				let img = this.logos.get(t.logo);
				if (!img) {
					img = this.el("img", "gd-logo");
					img.src = t.logo;
					img.alt = "";
					if (this.logos.size > 40) this.logos.clear();
					this.logos.set(t.logo, img);
				}
				w.appendChild(img);
			}
			w.appendChild(this.el("div", "gd-team-name", t.name || t.abbr));
			if (t.record) w.appendChild(this.el("div", "gd-team-record", t.record));
			return w;
		};
		const [away, home] = d.teams;
		const mid = this.el("div", "gd-mid");
		if (d.state !== "pre") mid.appendChild(this.el("div", "gd-score", (away ? away.score : "") + " – " + (home ? home.score : "")));
		mid.appendChild(this.el("div", "gd-status" + (d.state === "in" ? " gd-live" : ""), d.state === "pre" && d.date ? new Date(d.date).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : d.status));
		if (d.broadcast) mid.appendChild(this.el("div", "gd-sub", d.broadcast));
		if (away) h.appendChild(teamEl(away));
		h.appendChild(mid);
		if (home) h.appendChild(teamEl(home));
		return h;
	},

	section (parent, title) {
		const s = this.el("section", "gd-section");
		s.appendChild(this.el("h4", "gd-section-title", title));
		parent.appendChild(s);
		return s;
	},

	overview (body, d) {
		const [away, home] = d.teams;
		if (d.winChance && away && home) {
			const s = this.section(body, d.winChance.live ? "Win chance (live)" : "Win chance (ESPN projection)");
			const homePct = d.winChance.home;
			const bar = this.el("div", "gd-wp");
			const a = this.el("div", "gd-wp-away");
			a.style.width = (100 - homePct) + "%";
			bar.append(a);
			s.appendChild(bar);
			const labels = this.el("div", "gd-wp-labels");
			labels.append(this.el("span", "", away.abbr + " " + (100 - homePct) + "%"), this.el("span", "", home.abbr + " " + homePct + "%"));
			s.appendChild(labels);
		}
		if (d.odds) {
			const s = this.section(body, "Betting line" + (d.odds.provider ? " (" + d.odds.provider + ")" : ""));
			s.appendChild(this.el("div", "gd-line", [d.odds.line, d.odds.overUnder ? "O/U " + d.odds.overUnder : ""].filter(Boolean).join("   ·   ")));
		}
		if (d.venue || d.weather) {
			const s = this.section(body, "Venue");
			s.appendChild(this.el("div", "gd-line", [d.venue, d.weather].filter(Boolean).join(", ")));
		}
		if (d.stats && d.stats.length) {
			const s = this.section(body, "Team stats");
			const t = this.el("div", "gd-stats");
			t.append(this.el("span", "gd-stat-head", away ? away.abbr : ""), this.el("span", ""), this.el("span", "gd-stat-head", home ? home.abbr : ""));
			for (const r of d.stats) t.append(this.el("span", "gd-stat-v", r.away), this.el("span", "gd-stat-l", r.label), this.el("span", "gd-stat-v", r.home));
			s.appendChild(t);
		}
		if (!d.winChance && !d.odds && !d.stats) body.appendChild(this.el("div", "gd-empty", "More details appear closer to the game."));
	},

	plays (body, d) {
		const list = this.el("div", "gd-list");
		for (const p of d.scoring) {
			const row = this.el("div", "gd-play");
			row.append(this.el("span", "gd-play-when", p.when), this.el("span", "gd-play-team", p.team), this.el("span", "gd-play-text", p.text), this.el("span", "gd-play-score", p.score));
			list.appendChild(row);
		}
		body.appendChild(list);
	},

	players (body, d) {
		for (const lu of d.lineups || []) {
			const s = this.section(body, lu.team + " lineup" + (lu.formation ? " (" + lu.formation + ")" : ""));
			for (const p of lu.starters) {
				const row = this.el("div", "gd-person");
				row.append(this.el("span", "gd-num", p.number), this.el("span", "gd-name", p.name), this.el("span", "gd-pos", p.pos));
				s.appendChild(row);
			}
		}
		for (const t of d.leaders || []) {
			const s = this.section(body, t.team + " leaders");
			for (const i of t.items) {
				const row = this.el("div", "gd-person");
				row.append(this.el("span", "gd-cat", i.category), this.el("span", "gd-name", i.name), this.el("span", "gd-pos", i.value));
				s.appendChild(row);
			}
		}
	},

	injuries (body, d) {
		for (const t of d.injuries) {
			const s = this.section(body, t.team + " injuries");
			for (const i of t.items) {
				const row = this.el("div", "gd-person");
				row.append(this.el("span", "gd-name", i.name), this.el("span", "gd-cat", i.detail), this.el("span", "gd-pos", i.status));
				s.appendChild(row);
			}
		}
	},

	table (body, d) {
		for (const g of d.standings) {
			const s = this.section(body, g.title || "Standings");
			for (const r of g.rows) {
				const row = this.el("div", "gd-row" + (r.mine ? " gd-row-mine" : ""));
				row.append(this.el("span", "gd-name", r.team), this.el("span", "gd-pos", r.points ? r.points + " pts" : r.record));
				s.appendChild(row);
			}
		}
	},

	newsTab (body, d) {
		const list = this.el("ol", "gd-news");
		for (const n of d.news) list.appendChild(this.el("li", "", n.headline));
		body.appendChild(list);
	}
});
