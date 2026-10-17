/* MMM-YouTubeCast node_helper
 *
 * Runs a YouTube cast receiver (patrickkfkan/yt-cast-receiver, v2.1.1):
 *   - DIAL discovery: the YouTube app on a phone on the same Wi-Fi lists
 *     the mirror under its cast button (iPhone and Android alike).
 *   - "Link with TV code": a code shown on the Cast page pairs a phone once;
 *     afterwards the phone lists the mirror even off the home Wi-Fi.
 *     Pairing data is kept in data/receiver.json so it survives reboots.
 * The receiver needs a Player. Ours (BridgePlayer) forwards every command to
 * the browser, where YouTube's own embedded player plays the video, and
 * reports position, duration and volume back so phones show the right state.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");

const CMD_TIMEOUT_MS = 8000;
const LOAD_TIMEOUT_MS = 25000;

module.exports = NodeHelper.create({
	start () {
		this.started = false;
		this.pending = new Map(); // command id -> { resolve, timer }
		this.nextId = 1;
		this.uiState = { status: "idle", position: 0, duration: 0, volume: { level: 100, muted: false }, at: Date.now() };
		this.pairingCode = null;
		this.senders = [];
	},

	async stop () {
		try {
			if (this.pairing) this.pairing.stop();
			if (this.receiver) await this.receiver.stop();
		} catch (err) {
			Log.warn("[MMM-YouTubeCast] stop: " + err.message);
		}
	},

	// ---------- browser <-> helper ----------

	broadcastState () {
		this.sendSocketNotification("YTC_STATE", {
			pairingCode: this.pairingCode,
			senders: this.senders,
			deviceName: this.config && this.config.deviceName,
			receiver: this.receiver ? this.receiver.status : "stopped"
		});
	},

	/** Send a command to the browser player and wait for its ack. */
	command (cmd, args = {}, timeoutMs = CMD_TIMEOUT_MS) {
		const id = this.nextId++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				Log.warn("[MMM-YouTubeCast] no answer from the screen for '" + cmd + "'");
				resolve({ ok: false, error: "timeout" });
			}, timeoutMs);
			this.pending.set(id, { resolve, timer });
			this.sendSocketNotification("YTC_CMD", { id, cmd, args });
		});
	},

	async socketNotificationReceived (notification, payload) {
		try {
			if (notification === "YTC_INIT") {
				this.config = payload || {};
				if (!this.started) {
					this.started = true;
					await this.startReceiver();
				}
				this.broadcastState();
			} else if (notification === "YTC_PAIRING") {
				// The screen asks for a TV code only while the Cast page shows its idle
				// screen. See setPairing().
				this.setPairing(Boolean(payload && payload.want));
			} else if (notification === "YTC_ACK") {
				const entry = this.pending.get(payload && payload.id);
				if (entry) {
					clearTimeout(entry.timer);
					this.pending.delete(payload.id);
					entry.resolve(payload);
				}
			} else if (notification === "YTC_STATUS") {
				// Log what the screen's player reports whenever it changes, so sound
				// problems can be told apart (muted or volume 0 vs. no audio at all).
				const v = payload.volume || {};
				const line = payload.status + ", volume " + v.level + (v.muted ? ", MUTED" : "");
				if (line !== this.lastStatusLine) {
					this.lastStatusLine = line;
					Log.log("[MMM-YouTubeCast] screen player: " + line);
				}
				this.uiState = Object.assign({}, this.uiState, payload, { at: Date.now() });
			} else if (notification === "YTC_EVENT" && this.player) {
				if (payload.type === "ended") await this.player.handleEnded();
				else if (payload.type === "error") await this.player.handleError(payload.code);
			} else if (notification === "YTC_USER" && this.player) {
				// Taps on the fridge. Going through the Player keeps phones in sync.
				if (payload.action === "pause") await this.player.pause();
				else if (payload.action === "resume") await this.player.resume();
				else if (payload.action === "stop") {
					// Stop on the fridge also ends the cast on the phones. yt-cast-receiver
					// (v2.1.1) has no "disconnect this sender" call, so the receiver is
					// restarted, which ends every phone's session. Linked phones stay
					// linked and can cast again. A phone's own stop does not do this.
					await this.player.stop();
					if (!this.restarting) {
						this.restarting = true;
						Log.log("[MMM-YouTubeCast] stop on the fridge: disconnecting phones");
						this.senders = [];
						this.broadcastState();
						try {
							await this.restartReceiver();
						} finally {
							this.restarting = false;
						}
					}
				}
			} else if (notification === "YTC_DEBUG_PLAY" && this.player && this.config.debug) {
				// Local testing without a phone: play a video id through the full receiver path.
				await this.player.play({ id: String(payload.videoId), client: this.ytcr.CLIENTS.YT }, Number(payload.position) || 0);
			}
		} catch (err) {
			Log.error("[MMM-YouTubeCast] " + notification + " failed: " + err.message);
		}
	},

	// ---------- receiver ----------

	async startReceiver () {
		let ytcr;
		try {
			// yt-cast-receiver is an ES module; node helpers are CommonJS.
			ytcr = await import("yt-cast-receiver");
		} catch (err) {
			Log.error("[MMM-YouTubeCast] yt-cast-receiver is not installed (run ./install.sh --update): " + err.message);
			return;
		}
		this.ytcr = ytcr;
		const helper = this;
		const { Player, DataStore, PLAYER_STATUSES, RESET_PLAYER_ON_DISCONNECT_POLICIES } = ytcr;
		const YouTubeCastReceiver = ytcr.default;

		/** Pairing data in data/receiver.json (atomic writes), not node-persist in the cwd. */
		class JsonFileDataStore extends DataStore {
			constructor (file) {
				super();
				this.file = file;
				try {
					this.data = JSON.parse(fs.readFileSync(file, "utf-8"));
				} catch {
					this.data = {};
				}
			}

			async get (key) {
				return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
			}

			async set (key, value) {
				this.data[key] = value;
				fs.mkdirSync(path.dirname(this.file), { recursive: true });
				const tmp = this.file + ".tmp";
				fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
				fs.renameSync(tmp, this.file);
			}
		}

		class BridgePlayer extends Player {
			async doPlay (video, position) {
				const res = await helper.command("load", { videoId: video.id, position: position || 0, volume: helper.uiState.volume }, LOAD_TIMEOUT_MS);
				return res.ok === true;
			}

			async doPause () {
				return (await helper.command("pause")).ok === true;
			}

			async doResume () {
				return (await helper.command("resume")).ok === true;
			}

			async doStop () {
				const res = await helper.command("stop");
				// Treat a missing screen as stopped so phones do not hang.
				return res.ok === true || res.error === "timeout";
			}

			async doSeek (position) {
				return (await helper.command("seek", { position })).ok === true;
			}

			async doSetVolume (volume) {
				const res = await helper.command("volume", { volume });
				if (res.ok) helper.uiState.volume = volume;
				return res.ok === true;
			}

			async doGetVolume () {
				return helper.uiState.volume;
			}

			async doGetPosition () {
				const s = helper.uiState;
				const drift = s.status === "playing" ? (Date.now() - s.at) / 1000 : 0;
				return Math.max(0, (Number(s.position) || 0) + drift);
			}

			async doGetDuration () {
				return Number(helper.uiState.duration) || 0;
			}

			/** Video finished on screen: move to the next one (autoplay) or stop. */
			async handleEnded () {
				await this.pause();
				const moved = await this.next();
				if (!moved) await this.stop();
			}

			/** YouTube refused the video (e.g. embedding disabled). Skip it if possible. */
			async handleError (code) {
				Log.warn("[MMM-YouTubeCast] YouTube player error " + code + ", skipping video");
				const moved = await this.next();
				if (!moved) await this.stop();
			}
		}

		const level = this.config.debug ? "debug" : "warn";
		const logger = {
			error: (...m) => Log.error("[MMM-YouTubeCast]", ...m),
			warn: (...m) => Log.warn("[MMM-YouTubeCast]", ...m),
			info: (...m) => (level === "debug" ? Log.info("[MMM-YouTubeCast]", ...m) : undefined),
			debug: (...m) => (level === "debug" ? Log.debug("[MMM-YouTubeCast]", ...m) : undefined),
			setLevel: () => {}
		};

		const name = String(this.config.deviceName || "Fridge").slice(0, 40);
		this.player = new BridgePlayer();
		this.receiver = new YouTubeCastReceiver(this.player, {
			device: { name, screenName: name, brand: "MagicMirror", model: "Fridge Planner" },
			dial: { port: Number(this.config.dialPort) || 8569 },
			app: { resetPlayerOnDisconnectPolicy: RESET_PLAYER_ON_DISCONNECT_POLICIES.ALL_DISCONNECTED },
			dataStore: new JsonFileDataStore(path.join(this.path, "data", "receiver.json")),
			logger,
			logLevel: level
		});

		this.player.on("state", (data) => {
			const status = data && data.current ? data.current.status : null;
			if (status === PLAYER_STATUSES.STOPPED || status === PLAYER_STATUSES.IDLE) {
				this.sendSocketNotification("YTC_IDLE", {});
			}
		});

		const updateSenders = () => {
			this.senders = this.receiver.getConnectedSenders().map((s) => (s.user && s.user.name) || s.name || "Phone");
			this.applyPairing();
			this.broadcastState();
		};
		this.receiver.on("senderConnect", (s) => {
			Log.log("[MMM-YouTubeCast] phone connected: " + ((s && s.name) || "?"));
			updateSenders();
		});
		this.receiver.on("senderDisconnect", (s, implicit) => {
			// Logged so a dropped cast can be matched to its cause (time, phone).
			Log.log("[MMM-YouTubeCast] phone disconnected: " + ((s && s.name) || "?") + (implicit ? " (implicit)" : ""));
			updateSenders();
		});
		this.receiver.on("error", (err) => Log.error("[MMM-YouTubeCast] receiver error: " + (err && err.message)));
		this.receiver.on("terminate", (err) => {
			Log.error("[MMM-YouTubeCast] receiver stopped: " + (err && err.message) + ". Restarting in 30 s.");
			setTimeout(() => this.restartReceiver(), 30000);
		});

		try {
			await this.receiver.start();
			Log.log("[MMM-YouTubeCast] receiver '" + name + "' running, DIAL port " + (Number(this.config.dialPort) || 8569));
		} catch (err) {
			Log.error("[MMM-YouTubeCast] receiver failed to start: " + err.message + ". Retrying in 30 s.");
			setTimeout(() => this.restartReceiver(), 30000);
			return;
		}

		this.pairing = this.receiver.getPairingCodeRequestService();
		this.pairing.on("response", (code) => {
			this.pairingCode = String(code).replace(/(\d{3})(?=\d)/g, "$1 ").trim();
			this.broadcastState();
		});
		this.pairing.on("error", (err) => {
			Log.warn("[MMM-YouTubeCast] pairing code unavailable: " + (err && err.message) + ". Retrying in 60 s.");
			this.pairingCode = null;
			this.broadcastState();
			clearTimeout(this.pairingRetry);
			this.pairingRetry = setTimeout(() => this.applyPairing(), 60000);
		});
		this.applyPairing();
	},

	/* "Link with TV code" codes are fetched only while someone can see them:
	 * the Cast page is on screen and nothing is playing. The library refreshes
	 * the code every 5 minutes while its service runs (yt-cast-receiver
	 * PairingCodeRequestService); keeping that running during a cast lined up
	 * with casts dropping every 5 minutes (2026-10-17). A YouTube TV app also
	 * shows a code only on its "Link with TV code" screen. */
	setPairing (want) {
		this.pairingWanted = want;
		this.applyPairing();
	},

	applyPairing () {
		if (!this.pairing) return;
		clearTimeout(this.pairingRetry);
		const playing = this.senders && this.senders.length > 0;
		if (this.pairingWanted && !playing) {
			this.pairing.start();
		} else {
			this.pairing.stop();
			if (this.pairingCode) {
				this.pairingCode = null;
				this.broadcastState();
			}
		}
	},

	async restartReceiver () {
		try {
			if (this.pairing) this.pairing.stop();
			if (this.receiver) await this.receiver.stop();
		} catch {
			// ignore, we are replacing it
		}
		this.receiver = null;
		this.player = null;
		await this.startReceiver();
		this.broadcastState();
	}
});
