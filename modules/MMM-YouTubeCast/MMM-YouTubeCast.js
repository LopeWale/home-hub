/* MMM-YouTubeCast
 *
 * Cast page of the fridge planner. Idle: how to cast, plus the "Link with
 * TV code". Casting: YouTube's embedded player fills the screen, with large
 * Pause/Play and Stop buttons (tap the video to show them).
 *
 * Sends: PAGE_SELECT (to the cast page on start, home page on stop),
 *        YOUTUBE_CAST_STARTED, YOUTUBE_CAST_STOPPED,
 *        YOUTUBE_CAST_PLAYING (each time the video starts or resumes playing)
 */
Module.register("MMM-YouTubeCast", {
	defaults: {
		deviceName: "Fridge", // name shown in the YouTube app on phones
		dialPort: 8569, // LAN port for cast discovery (DIAL)
		homePage: 0,
		castPage: 1,
		returnHomeOnStop: true,
		controlsHideMs: 4000,
		statusIntervalMs: 1000,
		debug: false
	},

	getStyles () {
		return ["font-awesome.css", "MMM-YouTubeCast.css"];
	},

	start () {
		this.state = { pairingCode: null, senders: [], deviceName: this.config.deviceName };
		this.casting = false;
		this.yt = null;
		this.ytReady = null;
		this.pendingLoad = null;
		this.sendSocketNotification("YTC_INIT", {
			deviceName: this.config.deviceName,
			dialPort: this.config.dialPort,
			debug: this.config.debug
		});
	},

	// ---------- DOM ----------

	getDom () {
		const root = document.createElement("div");
		root.className = "ytc-root";

		this.idleEl = document.createElement("div");
		this.idleEl.className = "ytc-idle";
		root.appendChild(this.idleEl);

		this.stageEl = document.createElement("div");
		this.stageEl.className = "ytc-stage ytc-hidden";
		this.stageEl.setAttribute("data-no-swipe", "");
		const host = document.createElement("div");
		host.id = this.identifier + "_player";
		host.className = "ytc-player";
		this.stageEl.appendChild(host);

		// Transparent layer above the iframe so taps reach us, not YouTube.
		const tapLayer = document.createElement("div");
		tapLayer.className = "ytc-taplayer";
		tapLayer.addEventListener("click", () => this.showControls());
		this.stageEl.appendChild(tapLayer);

		this.controlsEl = document.createElement("div");
		this.controlsEl.className = "ytc-controls";
		this.playPauseBtn = this.button("fa-pause", "Pause", () => this.userAction(this.isPlaying() ? "pause" : "resume"));
		this.controlsEl.append(this.playPauseBtn, this.button("fa-stop", "Stop", () => this.userAction("stop")));
		this.stageEl.appendChild(this.controlsEl);

		this.messageEl = document.createElement("div");
		this.messageEl.className = "ytc-message ytc-hidden";
		this.stageEl.appendChild(this.messageEl);

		root.appendChild(this.stageEl);
		this.renderIdle();
		return root;
	},

	button (icon, label, onTap) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "ytc-btn";
		btn.innerHTML = "<i class=\"fa-solid " + icon + "\"></i>";
		const text = document.createElement("span");
		text.textContent = label;
		btn.appendChild(text);
		btn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			onTap();
			this.showControls();
		});
		return btn;
	},

	renderIdle () {
		if (!this.idleEl) return;
		const s = this.state;
		this.idleEl.replaceChildren();
		const title = document.createElement("div");
		title.className = "ytc-title";
		title.textContent = "Cast YouTube to " + (s.deviceName || this.config.deviceName);
		const steps = document.createElement("ol");
		steps.className = "ytc-steps";
		for (const line of [
			"On the same Wi-Fi: open the YouTube app, tap the cast or TV icon and pick “" + (s.deviceName || this.config.deviceName) + "”.",
			"Not listed, or away from home: in the YouTube app tap the cast icon, then “Link with TV code”, and enter the code below. You only do this once per phone."
		]) {
			const li = document.createElement("li");
			li.textContent = line;
			steps.appendChild(li);
		}
		const code = document.createElement("div");
		code.className = "ytc-code";
		code.textContent = s.pairingCode || (s.senders && s.senders.length ? "…" : "getting a TV code…");
		const sub = document.createElement("div");
		sub.className = "ytc-sub";
		sub.textContent = s.senders && s.senders.length ? "Connected: " + s.senders.join(", ") : "A new code appears every 5 minutes while this page is open.";
		this.idleEl.append(title, steps, code, sub);
	},

	// ---------- YouTube player ----------

	loadYouTubeApi () {
		if (window.YT && window.YT.Player) return Promise.resolve();
		if (this.ytReady) return this.ytReady;
		this.ytReady = new Promise((resolve, reject) => {
			const previous = window.onYouTubeIframeAPIReady;
			window.onYouTubeIframeAPIReady = () => {
				if (typeof previous === "function") previous();
				resolve();
			};
			const script = document.createElement("script");
			script.src = "https://www.youtube.com/iframe_api";
			script.onerror = () => {
				this.ytReady = null; // allow a retry on the next cast
				reject(new Error("could not load the YouTube player (no internet?)"));
			};
			document.head.appendChild(script);
		});
		return this.ytReady;
	},

	ensurePlayer () {
		if (this.yt) return Promise.resolve(this.yt);
		return this.loadYouTubeApi().then(() => new Promise((resolve) => {
			this.yt = new YT.Player(this.identifier + "_player", {
				width: "100%",
				height: "100%",
				playerVars: { autoplay: 1, controls: 0, rel: 0, playsinline: 1, disablekb: 1, iv_load_policy: 3, origin: location.origin },
				events: {
					onReady: () => resolve(this.yt),
					onStateChange: (e) => this.onPlayerState(e.data),
					onError: (e) => this.onPlayerError(e.data)
				}
			});
		}));
	},

	isPlaying () {
		return Boolean(this.yt && this.yt.getPlayerState && this.yt.getPlayerState() === YT.PlayerState.PLAYING);
	},

	onPlayerState (state) {
		if (state === YT.PlayerState.PLAYING && this.pendingLoad) {
			this.ack(this.pendingLoad, true);
			this.pendingLoad = null;
		}
		if (state === YT.PlayerState.PLAYING) this.sendNotification("YOUTUBE_CAST_PLAYING", {});
		if (state === YT.PlayerState.ENDED) this.sendSocketNotification("YTC_EVENT", { type: "ended" });
		this.updatePlayPause();
		this.reportStatus();
	},

	onPlayerError (code) {
		// 101/150: owner does not allow embedding. 100: removed or private. 2/5: bad request or HTML5 error.
		const text = code === 101 || code === 150 ? "This video's owner does not allow playback outside YouTube." : code === 100 ? "This video is private or was removed." : "YouTube could not play this video (error " + code + ").";
		this.showMessage(text);
		if (this.pendingLoad) {
			this.ack(this.pendingLoad, false, "youtube error " + code);
			this.pendingLoad = null;
		} else {
			this.sendSocketNotification("YTC_EVENT", { type: "error", code });
		}
	},

	reportStatus () {
		if (!this.yt || !this.yt.getPlayerState) return;
		const st = this.yt.getPlayerState();
		const map = { 1: "playing", 2: "paused", 3: "buffering", 0: "ended", 5: "cued" };
		this.sendSocketNotification("YTC_STATUS", {
			status: map[st] || "idle",
			position: this.yt.getCurrentTime() || 0,
			duration: this.yt.getDuration() || 0,
			volume: { level: this.yt.getVolume(), muted: this.yt.isMuted() }
		});
	},

	applyVolume (volume) {
		if (!this.yt || !volume) return;
		this.yt.setVolume(Math.max(0, Math.min(100, Number(volume.level) || 0)));
		if (volume.muted) this.yt.mute();
		else this.yt.unMute();
	},

	// ---------- commands from the receiver ----------

	ack (id, ok, error) {
		this.sendSocketNotification("YTC_ACK", { id, ok, error: error || null });
	},

	async runCommand ({ id, cmd, args }) {
		try {
			if (cmd === "load") {
				this.enterCasting();
				const yt = await this.ensurePlayer();
				this.hideMessage();
				if (this.pendingLoad) this.ack(this.pendingLoad, false, "superseded");
				this.pendingLoad = id; // acked when YouTube reports PLAYING (or an error)
				yt.loadVideoById({ videoId: args.videoId, startSeconds: Number(args.position) || 0 });
				this.applyVolume(args.volume);
				return;
			}
			if (!this.yt) {
				this.ack(id, cmd === "stop");
				if (cmd === "stop") this.leaveCasting();
				return;
			}
			if (cmd === "pause") this.yt.pauseVideo();
			else if (cmd === "resume") this.yt.playVideo();
			else if (cmd === "seek") this.yt.seekTo(Number(args.position) || 0, true);
			else if (cmd === "volume") this.applyVolume(args.volume);
			else if (cmd === "stop") {
				this.yt.stopVideo();
				this.leaveCasting();
			}
			this.ack(id, true);
			this.reportStatus();
		} catch (err) {
			Log.error("MMM-YouTubeCast: " + cmd + " failed: " + err.message);
			if (cmd === "load") this.showMessage("Could not start playback: " + err.message);
			this.ack(id, false, err.message);
		}
	},

	enterCasting () {
		if (this.casting) return;
		this.casting = true;
		this.updatePairing();
		this.stageEl.classList.remove("ytc-hidden");
		this.stageEl.classList.add("ytc-fullscreen");
		this.sendNotification("PAGE_SELECT", this.config.castPage);
		this.sendNotification("YOUTUBE_CAST_STARTED", {});
		clearInterval(this.statusTimer);
		this.statusTimer = setInterval(() => this.reportStatus(), this.config.statusIntervalMs);
		this.showControls();
	},

	leaveCasting () {
		if (!this.casting) return;
		this.casting = false;
		this.updatePairing();
		clearInterval(this.statusTimer);
		this.stageEl.classList.add("ytc-hidden");
		this.stageEl.classList.remove("ytc-fullscreen");
		this.hideMessage();
		this.sendNotification("YOUTUBE_CAST_STOPPED", {});
		if (this.config.returnHomeOnStop) this.sendNotification("PAGE_SELECT", this.config.homePage);
		this.reportStatus();
	},

	userAction (action) {
		this.sendSocketNotification("YTC_USER", { action });
	},

	// ---------- UI helpers ----------

	updatePlayPause () {
		if (!this.playPauseBtn) return;
		const playing = this.isPlaying();
		this.playPauseBtn.querySelector("i").className = "fa-solid " + (playing ? "fa-pause" : "fa-play");
		this.playPauseBtn.querySelector("span").textContent = playing ? "Pause" : "Play";
	},

	showControls () {
		if (!this.controlsEl) return;
		this.controlsEl.classList.add("ytc-visible");
		clearTimeout(this.controlsTimer);
		this.controlsTimer = setTimeout(() => this.controlsEl.classList.remove("ytc-visible"), this.config.controlsHideMs);
	},

	showMessage (text) {
		this.messageEl.textContent = text;
		this.messageEl.classList.remove("ytc-hidden");
	},

	hideMessage () {
		if (this.messageEl) this.messageEl.classList.add("ytc-hidden");
	},

	// ---------- MagicMirror hooks ----------

	socketNotificationReceived (notification, payload) {
		if (notification === "YTC_STATE") {
			this.state = Object.assign({}, this.state, payload);
			this.renderIdle();
		} else if (notification === "YTC_CMD") {
			this.runCommand(payload);
		} else if (notification === "YTC_IDLE") {
			this.leaveCasting();
		}
	},

	/** Ask the helper for TV codes only while the idle Cast page is on screen. */
	updatePairing () {
		this.sendSocketNotification("YTC_PAIRING", { want: this.onScreen === true && !this.casting });
	},

	suspend () {
		this.onScreen = false;
		this.updatePairing();
		// Someone left the cast page while a video plays: pause it, phones see the pause.
		if (this.isPlaying()) this.userAction("pause");
	},

	resume () {
		this.onScreen = true;
		this.updatePairing();
	}
});
