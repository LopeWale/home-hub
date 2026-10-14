/* MMM-BluetoothAudio
 *
 * Bluetooth icon in the top bar, next to the network icon. A dot on it means
 * a speaker is connected and the sound plays there. Tap it for a popup:
 * where the sound plays now, paired speakers (Connect / Disconnect / Forget),
 * and "Find new speaker" to pair one.
 *
 * The chosen speaker may go to sleep; it is woken when a cast starts or
 * resumes (YOUTUBE_CAST_STARTED / YOUTUBE_CAST_PLAYING from MMM-YouTubeCast).
 *
 * Sends BTA_INIT, BTA_REFRESH, BTA_SCAN, BTA_CONNECT, BTA_DISCONNECT,
 * BTA_FORGET, BTA_POWER, BTA_WAKE. Receives BTA_STATE.
 */
Module.register("MMM-BluetoothAudio", {
	defaults: {
		checkMs: 2 * 60 * 1000, // how often to check where the sound goes (local only, never wakes the speaker)
		refreshMs: 30 * 1000, // icon refresh while the popup is closed
		closeAfterMs: 3 * 60 * 1000
	},

	getStyles () {
		return ["MMM-BluetoothAudio.css"];
	},

	start () {
		this.btState = null;
		this.sendSocketNotification("BTA_INIT", { checkMs: this.config.checkMs });
		setInterval(() => {
			if (!this.popup) this.sendSocketNotification("BTA_REFRESH");
		}, this.config.refreshMs);
		document.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") this.closePopup();
		});
	},

	getDom () {
		if (!this.button) {
			this.button = document.createElement("button");
			this.button.type = "button";
			this.button.className = "bta-icon";
			this.button.addEventListener("click", (ev) => {
				ev.stopPropagation();
				this.openPopup();
			});
		}
		this.renderIcon();
		return this.button;
	},

	renderIcon () {
		if (!this.button) return;
		const s = this.btState;
		const on = Boolean(s && s.outputIsBluetooth);
		const off = Boolean(s && (!s.present || !s.powered));
		this.button.classList.toggle("bta-connected", on);
		this.button.classList.toggle("bta-off", off);
		const label = !s ? "Bluetooth" : !s.present ? "No Bluetooth on this Pi" : !s.powered ? "Bluetooth is off" : "Sound plays on: " + s.output + ". Tap for Bluetooth speakers.";
		this.button.setAttribute("aria-label", label);
		this.button.title = label;
		this.button.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M7 7l10 10-5 4V3l5 4L7 17\"/></svg><span class=\"bta-dot\"></span>";
	},

	// ---------- popup ----------

	openPopup () {
		this.closePopup();
		const backdrop = document.createElement("div");
		backdrop.className = "bta-backdrop";
		backdrop.addEventListener("click", (ev) => {
			if (ev.target === backdrop) this.closePopup();
		});
		const card = document.createElement("div");
		card.className = "bta-card";
		backdrop.appendChild(card);
		document.body.appendChild(backdrop);
		this.popup = { backdrop, card };
		this.renderPopup();
		this.sendSocketNotification("BTA_REFRESH");
		this.popupTimer = setInterval(() => this.sendSocketNotification("BTA_REFRESH"), 5000);
		this.closeTimer = setTimeout(() => this.closePopup(), this.config.closeAfterMs);
	},

	closePopup () {
		clearInterval(this.popupTimer);
		clearTimeout(this.closeTimer);
		if (this.popup) this.popup.backdrop.remove();
		this.popup = null;
	},

	el (tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	},

	pill (text, onTap, cls) {
		const b = this.el("button", "bta-pill" + (cls ? " " + cls : ""), text);
		b.type = "button";
		b.disabled = Boolean(this.btState && this.btState.busy);
		b.addEventListener("click", (ev) => {
			ev.stopPropagation();
			onTap();
		});
		return b;
	},

	renderPopup () {
		if (!this.popup) return;
		const card = this.popup.card;
		const s = this.btState;
		card.replaceChildren();
		card.appendChild(this.el("div", "bta-heading", "Bluetooth speakers"));

		if (!s) {
			card.appendChild(this.el("div", "bta-note", "Checking Bluetooth…"));
		} else if (!s.present) {
			card.appendChild(this.el("div", "bta-note", "This Pi reports no Bluetooth adapter."));
		} else if (!s.powered) {
			card.appendChild(this.el("div", "bta-note", "Bluetooth is off."));
			card.appendChild(this.pill("Turn Bluetooth on", () => this.sendSocketNotification("BTA_POWER", { on: true }), "bta-primary"));
		} else {
			const now = this.el("div", "bta-output");
			now.append(this.el("span", "bta-output-label", "Sound plays on"), this.el("strong", "", s.output));
			card.appendChild(now);
			if (s.message) card.appendChild(this.el("div", "bta-note", s.message));

			const list = this.el("div", "bta-list");
			const paired = s.devices.filter((d) => d.paired);
			const fresh = s.devices.filter((d) => !d.paired);
			if (!paired.length) list.appendChild(this.el("div", "bta-note", "No speakers paired yet. Tap “Find new speaker”."));
			for (const d of paired) list.appendChild(this.row(d));
			if (fresh.length) {
				list.appendChild(this.el("div", "bta-sub", "Found nearby"));
				for (const d of fresh) list.appendChild(this.row(d));
			}
			card.appendChild(list);

			const actions = this.el("div", "bta-actions");
			actions.appendChild(this.pill(s.busy === "scanning" ? "Looking…" : "Find new speaker", () => this.sendSocketNotification("BTA_SCAN")));
			card.appendChild(actions);
		}

		const done = this.el("button", "bta-close", "Done");
		done.type = "button";
		done.addEventListener("click", () => this.closePopup());
		card.appendChild(done);
	},

	row (d) {
		const row = this.el("div", "bta-row" + (d.connected ? " bta-row-on" : ""));
		const text = this.el("div", "bta-row-text");
		text.appendChild(this.el("div", "bta-row-name", d.name));
		const status = d.connected ? "Connected" : d.paired ? (this.btState.preferred === d.mac ? "Will reconnect when it is on" : "Paired") : d.audio ? "Speaker, not paired" : "Not paired";
		text.appendChild(this.el("div", "bta-row-status", status));
		row.appendChild(text);
		const buttons = this.el("div", "bta-row-buttons");
		if (d.connected) {
			buttons.appendChild(this.pill("Disconnect", () => this.sendSocketNotification("BTA_DISCONNECT", { mac: d.mac })));
		} else {
			buttons.appendChild(this.pill(d.paired ? "Connect" : "Pair & connect", () => this.sendSocketNotification("BTA_CONNECT", { mac: d.mac }), "bta-primary"));
		}
		if (d.paired) buttons.appendChild(this.pill("Forget", () => this.sendSocketNotification("BTA_FORGET", { mac: d.mac }), "bta-quiet"));
		row.appendChild(buttons);
		return row;
	},

	notificationReceived (notification) {
		if (notification === "YOUTUBE_CAST_STARTED" || notification === "YOUTUBE_CAST_PLAYING") this.sendSocketNotification("BTA_WAKE");
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "BTA_STATE") {
			this.btState = payload;
			this.renderIcon();
			this.renderPopup();
		}
	}
});
