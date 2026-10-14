#!/usr/bin/env node
"use strict";

/*
 * mm-configbridge: Tailscale only admin UI for MagicMirror.
 *
 * - Binds to this machine's Tailscale IP (never 0.0.0.0).
 * - Accepts requests only from Tailscale addresses (100.64.0.0/10,
 *   fd7a:115c:a1e0::/48), optionally only from listed Tailscale users.
 * - Every API call is POST + JSON + "Authorization: Bearer <token>".
 * - Edits config.bridge.json (and SECRET_BRIDGE_* lines in config.env)
 *   only, then restarts MagicMirror and waits until the change is live.
 *
 * Settings come from bridge.env (see bridge.env.example).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

// ---------- settings ----------

const ENV_FILE = process.env.BRIDGE_ENV_FILE || path.join(os.homedir(), ".config", "mm-configbridge", "bridge.env");
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const SETTINGS = {
	token: process.env.BRIDGE_TOKEN || "",
	port: Number(process.env.BRIDGE_PORT || 8081),
	bind: process.env.BRIDGE_BIND || "tailscale",
	allowLoopback: process.env.BRIDGE_ALLOW_LOOPBACK === "1",
	allowedUsers: (process.env.BRIDGE_ALLOWED_TAILSCALE_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
	basicUser: process.env.BRIDGE_BASIC_USER || "",
	basicPass: process.env.BRIDGE_BASIC_PASS || "",
	mmDir: process.env.MM_DIR || path.join(os.homedir(), "MagicMirror"),
	mmUrl: process.env.MM_URL || "http://localhost:8080",
	restartCmd: (process.env.MM_RESTART_CMD || "systemctl --user restart magicmirror.service").split(/\s+/).filter(Boolean),
	liveTimeoutMs: Number(process.env.MM_LIVE_TIMEOUT_S || 180) * 1000,
	skipConfigCheck: process.env.BRIDGE_SKIP_CONFIG_CHECK === "1",
	stateDir: process.env.BRIDGE_STATE_DIR || path.join(os.homedir(), ".local", "state", "mm-configbridge")
};

// Libraries read MM_DIR at load time.
process.env.MM_DIR = SETTINGS.mmDir;

const { Store, revisionOf } = require("./lib/store");
const { Mirror } = require("./lib/mm");
const { validate, mapSecrets, pick } = require("./lib/validate");
const envfile = require("./lib/envfile");
const merge = require("./lib/merge");
const net = require("./lib/net");
const sec = require("./lib/security");
const teams = require("./lib/teams");

if (SETTINGS.token.length < 24) {
	console.error("mm-configbridge: BRIDGE_TOKEN missing or shorter than 24 characters in " + ENV_FILE);
	process.exit(1);
}

const store = new Store({ mmConfigDir: path.join(SETTINGS.mmDir, "config"), stateDir: SETTINGS.stateDir });
const mirror = new Mirror({ mmDir: SETTINGS.mmDir, mmUrl: SETTINGS.mmUrl, restartCmd: SETTINGS.restartCmd });
const limiter = new sec.RateLimiter();

// ---------- schemas ----------

function loadSchemas () {
	const dir = path.join(__dirname, "schemas");
	const schemas = {};
	// Skip hidden files: a Mac copying to a USB stick adds "._name.json" twins.
	for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort()) {
		const schema = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
		if (!schema.module || !schema.config) throw new Error("schema " + file + " needs module and config");
		schemas[schema.module] = schema;
	}
	return schemas;
}
const SCHEMAS = loadSchemas();

// ---------- logging ----------

const ACCESS_LOG = path.join(SETTINGS.stateDir, "access.log");
fs.mkdirSync(SETTINGS.stateDir, { recursive: true, mode: 0o700 });

function accessLog (entry) {
	const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + "\n";
	try {
		const stat = fs.statSync(ACCESS_LOG, { throwIfNoEntry: false });
		if (stat && stat.size > 5 * 1024 * 1024) fs.renameSync(ACCESS_LOG, ACCESS_LOG + ".1");
		fs.appendFileSync(ACCESS_LOG, line, { mode: 0o600 });
	} catch (err) {
		console.error("access log write failed: " + err.message);
	}
}

// ---------- helpers ----------

const SECURITY_HEADERS = {
	"Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store"
};

function send (res, status, body, type = "application/json; charset=utf-8") {
	const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
	res.writeHead(status, Object.assign({ "Content-Type": type }, SECURITY_HEADERS));
	res.end(payload);
}

function readJsonBody (req, limit = 512 * 1024) {
	return new Promise((resolve, reject) => {
		if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) {
			reject(Object.assign(new Error("Content-Type must be application/json"), { status: 415 }));
			return;
		}
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error("request body too large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				const text = Buffer.concat(chunks).toString("utf-8");
				resolve(text ? JSON.parse(text) : {});
			} catch {
				reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
			}
		});
		req.on("error", reject);
	});
}

const whoisCache = new Map();
async function tailscaleUserAllowed (ip) {
	if (SETTINGS.allowedUsers.length === 0) return true;
	if (net.isLoopback(ip) && SETTINGS.allowLoopback) return true;
	const cached = whoisCache.get(ip);
	if (cached && cached.expires > Date.now()) return cached.ok;
	const login = await net.tailscaleWhois(ip);
	const ok = Boolean(login) && SETTINGS.allowedUsers.includes(login.toLowerCase());
	whoisCache.set(ip, { ok, expires: Date.now() + 5 * 60 * 1000 });
	return ok;
}

// ---------- config model ----------

/** Effective (redacted) editable config per module: live MagicMirror first, bridge file second. */
async function effectiveConfig () {
	const [live, bridge] = await Promise.all([mirror.liveConfig(), store.readBridge()]);
	const modules = {};
	for (const [name, schema] of Object.entries(SCHEMAS)) {
		const liveEntry = live && Array.isArray(live.modules) ? live.modules.find((m) => m.module === name) : null;
		const installed = Boolean(liveEntry) || !live;
		const source = liveEntry ? liveEntry.config || {} : bridge.data[name] || {};
		modules[name] = { installed, values: pick(schema.config, source) || {} };
	}
	return { live: Boolean(live), liveError: live ? null : mirror.lastError || "unreachable", revision: bridge.revision, modules };
}

/** All secret names referenced at x-secret fields of the effective editable config. */
async function revealableSecrets () {
	const eff = await effectiveConfig();
	const names = new Set();
	for (const [name, schema] of Object.entries(SCHEMAS)) {
		mapSecrets(schema.config, eff.modules[name].values, (value) => {
			const secretName = merge.placeholderName(value);
			if (secretName) names.add(secretName);
			return value;
		});
	}
	return names;
}

function newSecretName (moduleName, taken) {
	const base = envfile.MANAGED_PREFIX + moduleName.replace(/^MMM-/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16);
	for (;;) {
		const name = base + "_" + crypto.randomBytes(3).toString("hex").toUpperCase();
		if (!taken.has(name)) return name;
	}
}

/**
 * Turn submitted module values into bridge overrides:
 * raw secret values become SECRET_BRIDGE_* entries. An existing
 * placeholder is accepted only if it is already used by an editable secret
 * field (allowedExisting) or is bridge managed, so a saved form can never
 * point a calendar URL at, say, the Google Maps key and then reveal it.
 */
function prepareOverrides (submitted, envValues, allowedExisting = new Set()) {
	const errors = [];
	const overrides = {};
	const managed = {};
	const valueToName = new Map(Object.entries(envValues).map(([k, v]) => [v, k]));
	const taken = new Set(Object.keys(envValues));

	for (const [moduleName, values] of Object.entries(submitted || {})) {
		const schema = SCHEMAS[moduleName];
		if (!schema) {
			errors.push(moduleName + " is not bridge editable");
			continue;
		}
		const problems = validate(schema.config, values, moduleName);
		if (problems.length > 0) {
			errors.push(...problems);
			continue;
		}
		overrides[moduleName] = mapSecrets(schema.config, values, (value) => {
			const existing = merge.placeholderName(value);
			if (existing) {
				if (!allowedExisting.has(existing) && !existing.startsWith(envfile.MANAGED_PREFIX)) {
					errors.push(moduleName + ": secret " + existing + " cannot be used here");
				} else if (!(existing in envValues)) {
					errors.push(moduleName + ": secret " + existing + " is not defined in config.env");
				}
				return value;
			}
			if (value === "") return value;
			let name = valueToName.get(value);
			if (!name) {
				name = newSecretName(moduleName, taken);
				taken.add(name);
				valueToName.set(value, name);
			}
			if (name.startsWith(envfile.MANAGED_PREFIX)) managed[name] = value;
			return merge.makePlaceholder(name);
		});
	}
	return { errors, overrides, managed };
}

/** Is `expected` contained in `actual`? Arrays must match exactly. */
function isSubset (expected, actual) {
	if (Array.isArray(expected)) return JSON.stringify(expected) === JSON.stringify(actual);
	if (merge.isPlainObject(expected)) {
		return merge.isPlainObject(actual) && Object.keys(expected).every((k) => isSubset(expected[k], actual[k]));
	}
	return expected === actual;
}

// ---------- save job ----------

let job = null; // { id, phase, message, startedAt, finishedAt, backupId }

function setPhase (phase, message) {
	if (!job) return;
	job.phase = phase;
	job.message = message || "";
	job.updatedAt = new Date().toISOString();
	if (["live", "failed", "restored"].includes(phase)) job.finishedAt = job.updatedAt;
	console.log("save " + job.id + ": " + phase + (message ? " (" + sec.redactUrls(message) + ")" : ""));
}

async function waitForLive (prevStartup, expected) {
	const deadline = Date.now() + SETTINGS.liveTimeoutMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2000));
		const now = await mirror.startup();
		if (!now || now === prevStartup) continue;
		const live = await mirror.liveConfig();
		if (!live) continue;
		const ok = Object.entries(expected).every(([name, values]) => {
			const entry = (live.modules || []).find((m) => m.module === name);
			return !entry || isSubset(values, entry.config || {});
		});
		return ok ? "live" : "mismatch";
	}
	return "timeout";
}

async function restoreAndRestart (reason) {
	try {
		await store.restore(job.backupId);
		const prev = await mirror.startup();
		await mirror.restart();
		const result = await waitForLive(prev, {});
		setPhase("restored", reason + ". Previous config restored" + (result === "live" ? " and MagicMirror is back up." : ", but MagicMirror did not come back. Check: journalctl --user -u magicmirror"));
	} catch (err) {
		setPhase("failed", reason + ". Restore also failed: " + err.message);
	}
}

async function runSave (overrides, managed, envText) {
	let backupId;
	try {
		backupId = await store.backup();
	} catch (err) {
		setPhase("failed", "Backup failed, nothing was changed: " + err.message);
		return;
	}
	job.backupId = backupId;
	try {
		const bridge = await store.readBridge();
		const next = Object.assign({}, bridge.data, overrides);
		// Drop managed secrets nothing references any more.
		const referenced = merge.collectSecretNames(next);
		const currentManaged = Object.fromEntries(Object.entries(envfile.parse(envText)).filter(([k]) => k.startsWith(envfile.MANAGED_PREFIX) && referenced.has(k)));
		const finalManaged = Object.assign(currentManaged, managed);
		for (const k of Object.keys(finalManaged)) if (!referenced.has(k)) delete finalManaged[k];

		await store.writeEnv(envfile.updateManaged(envText, finalManaged));
		await store.writeBridge(next);
		setPhase("saved", "Files written. Backup " + backupId);

		if (!SETTINGS.skipConfigCheck) {
			setPhase("checking", "Running MagicMirror config check");
			const check = await mirror.checkConfig();
			if (!check.ok) {
				await store.restore(backupId);
				setPhase("restored", "Config check failed, nothing applied. " + check.output);
				return;
			}
		}

		const prevStartup = await mirror.startup();
		setPhase("reloading", "Restarting MagicMirror");
		await mirror.restart();
		const result = await waitForLive(prevStartup, overrides);
		if (result === "live") setPhase("live", "MagicMirror restarted with the new config.");
		else await restoreAndRestart(result === "timeout" ? "MagicMirror did not come back within " + SETTINGS.liveTimeoutMs / 1000 + " s" : "MagicMirror came back without the new values");
	} catch (err) {
		await restoreAndRestart("Save failed: " + err.message);
	}
}

// ---------- calendar test ----------

async function testCalendar (url) {
	let target;
	try {
		target = new URL(url.replace(/^webcal:/i, "https:"));
	} catch {
		return { ok: false, message: "Not a valid URL" };
	}
	if (!["https:", "http:"].includes(target.protocol)) return { ok: false, message: "Only http, https or webcal URLs" };
	try {
		const res = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { "User-Agent": "mm-configbridge/1.0" } });
		if (!res.ok) return { ok: false, httpStatus: res.status, message: "Feed returned HTTP " + res.status };
		const reader = res.body.getReader();
		let size = 0;
		let text = "";
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 15 * 1024 * 1024) {
				await reader.cancel();
				return { ok: false, message: "Feed is larger than 15 MB" };
			}
			text += decoder.decode(value, { stream: true });
		}
		if (!text.includes("BEGIN:VCALENDAR")) return { ok: false, httpStatus: res.status, message: "Response is not an iCal feed" };
		const events = (text.match(/^BEGIN:VEVENT/gm) || []).length;
		return { ok: true, httpStatus: res.status, events, message: events + " events in feed" };
	} catch (err) {
		return { ok: false, message: "Fetch failed: " + sec.redactUrls(err.name === "TimeoutError" ? "timed out after 20 s" : err.message) };
	}
}

// ---------- routes ----------

const ADMIN_DIR = path.join(__dirname, "admin");
const STATIC = {
	"/admin": ["index.html", "text/html; charset=utf-8"],
	"/admin/": ["index.html", "text/html; charset=utf-8"],
	"/admin/app.js": ["app.js", "text/javascript; charset=utf-8"],
	"/admin/style.css": ["style.css", "text/css; charset=utf-8"]
};

const API = {
	"/api/config/get": async () => {
		const eff = await effectiveConfig();
		const schemas = Object.fromEntries(Object.entries(SCHEMAS).map(([k, v]) => [k, { title: v.title, description: v.description || "", config: v.config }]));
		return { status: 200, body: Object.assign(eff, { schemas, lastSaved: job && job.phase === "live" ? job.finishedAt : null }) };
	},

	"/api/config": async (body) => {
		if (job && !job.finishedAt) return { status: 409, body: { error: "A save is already in progress" } };
		const bridge = await store.readBridge();
		if (body.revision && body.revision !== bridge.revision) {
			return { status: 409, body: { error: "config.bridge.json changed since you loaded it. Reload the page." } };
		}
		// With MagicMirror down, the form only saw config.bridge.json, not the base
		// values in config.js. Arrays replace on merge, so saving a module that has
		// no bridge entry yet would silently drop its config.js values (e.g. feeds).
		if (!(await mirror.liveConfig())) {
			const unseen = Object.keys(body.modules || {}).filter((name) => !merge.isPlainObject(bridge.data[name]));
			if (unseen.length > 0) {
				return { status: 409, body: { error: "MagicMirror is offline, so the current values of " + unseen.join(", ") + " are not visible. Start MagicMirror first (systemctl --user start magicmirror), then reload this page." } };
			}
		}
		const envText = await store.readEnv();
		const envValues = envfile.parse(envText);
		const { errors, overrides, managed } = prepareOverrides(body.modules, envValues, await revealableSecrets());
		if (errors.length > 0) return { status: 422, body: { error: "Validation failed", details: errors.map(sec.redactUrls) } };
		if (Object.keys(overrides).length === 0) return { status: 400, body: { error: "Nothing to save" } };
		job = { id: Date.now().toString(36), phase: "validating", message: "", startedAt: new Date().toISOString() };
		runSave(overrides, managed, envText).catch((err) => setPhase("failed", err.message));
		return { status: 202, body: { job } };
	},

	"/api/status": async () => {
		const startup = await mirror.startup();
		return { status: 200, body: { job, mirrorUp: Boolean(startup), revision: revisionOf((await store.readBridge()).text) } };
	},

	"/api/test-calendar": async (body) => {
		let url = typeof body.url === "string" ? body.url.trim() : "";
		const secretName = merge.placeholderName(url) || (typeof body.secret === "string" ? body.secret : null);
		if (secretName) {
			const allowed = await revealableSecrets();
			if (!allowed.has(secretName)) return { status: 404, body: { error: "Unknown calendar secret" } };
			url = envfile.parse(await store.readEnv())[secretName] || "";
			if (!url) return { status: 404, body: { error: "Secret has no value in config.env" } };
		}
		if (!url) return { status: 400, body: { error: "url required" } };
		return { status: 200, body: await testCalendar(url) };
	},

	"/api/secret/reveal": async (body) => {
		const name = typeof body.name === "string" ? body.name : merge.placeholderName(body.placeholder);
		const allowed = await revealableSecrets();
		if (!name || !allowed.has(name)) return { status: 404, body: { error: "Unknown secret" } };
		const value = envfile.parse(await store.readEnv())[name];
		if (!value) return { status: 404, body: { error: "Secret has no value in config.env" } };
		return { status: 200, body: { name, value } };
	},

	"/api/backups": async () => ({ status: 200, body: { backups: await store.listBackups() } }),

	// Team picker: ESPN's team list for one league (cached on the Pi for a day).
	"/api/teams": async (body) => {
		const league = typeof body.league === "string" ? body.league : "";
		if (!/^[A-Z0-9_]{2,40}$/.test(league)) return { status: 400, body: { error: "league required" } };
		try {
			return { status: 200, body: await teams.teamsFor(league) };
		} catch (err) {
			return { status: 502, body: { error: "Could not load teams from ESPN: " + (err.name === "TimeoutError" ? "timed out" : err.message) } };
		}
	}
};

async function handle (req, res) {
	const started = Date.now();
	const ip = net.normalizeIp(req.socket.remoteAddress);
	const url = new URL(req.url, "http://bridge");
	const route = url.pathname;
	const done = (status, body, type) => {
		send(res, status, body, type);
		accessLog({ ip, method: req.method, path: route, status, ms: Date.now() - started });
	};

	// 1. network origin
	const fromTailnet = net.isTailscaleAddress(ip);
	if (!fromTailnet && !(SETTINGS.allowLoopback && net.isLoopback(ip))) return done(403, { error: "Tailscale only" });
	if (!(await tailscaleUserAllowed(ip))) return done(403, { error: "Tailscale user not allowed" });

	// 2. rate limit
	const rate = limiter.allow(ip);
	if (!rate.ok) return done(429, { error: rate.reason === "locked" ? "Too many failed logins, try again later" : "Too many requests" });

	// 3. optional basic auth (covers the page too)
	if (SETTINGS.basicUser && SETTINGS.basicPass && !sec.checkBasic(req, SETTINGS.basicUser, SETTINGS.basicPass)) {
		limiter.recordAuthFailure(ip);
		res.setHeader("WWW-Authenticate", "Basic realm=\"mm-configbridge\"");
		return done(401, { error: "Authentication required" });
	}

	// 4. static admin page (contains no secrets)
	if (req.method === "GET" && (route === "/" || route === "")) {
		res.writeHead(302, { Location: "/admin" });
		res.end();
		return accessLog({ ip, method: req.method, path: route, status: 302 });
	}
	if (req.method === "GET" && STATIC[route]) {
		const [file, type] = STATIC[route];
		try {
			return done(200, await fsp.readFile(path.join(ADMIN_DIR, file)), type);
		} catch {
			return done(404, { error: "not found" });
		}
	}

	// 5. API: POST + bearer token only
	const api = API[route];
	if (!api) return done(404, { error: "not found" });
	if (req.method !== "POST") return done(405, { error: "POST only" });
	if (!sec.checkBearer(req, SETTINGS.token)) {
		limiter.recordAuthFailure(ip);
		return done(401, { error: "Bad or missing token" });
	}
	limiter.recordAuthSuccess(ip);
	try {
		const body = await readJsonBody(req);
		const result = await api(body);
		return done(result.status, result.body);
	} catch (err) {
		console.error("api " + route + " failed: " + sec.redactUrls(err.message));
		return done(err.status || 500, { error: err.status ? err.message : "Internal error" });
	}
}

// ---------- startup ----------

function resolveBindAddress () {
	if (SETTINGS.bind === "tailscale") return net.findTailscaleIPv4();
	if (["0.0.0.0", "::", ""].includes(SETTINGS.bind)) {
		console.error("mm-configbridge: refusing to bind to all interfaces. Use BRIDGE_BIND=tailscale.");
		process.exit(1);
	}
	return SETTINGS.bind;
}

async function main () {
	await store.init();
	let address = resolveBindAddress();
	while (!address) {
		console.log("mm-configbridge: waiting for a Tailscale IPv4 address (is tailscale up?)");
		await new Promise((r) => setTimeout(r, 5000));
		address = resolveBindAddress();
	}
	const server = http.createServer((req, res) => {
		handle(req, res).catch((err) => {
			console.error("request failed: " + sec.redactUrls(err.message));
			if (!res.headersSent) send(res, 500, { error: "Internal error" });
		});
	});
	server.headersTimeout = 15000;
	server.requestTimeout = 30000;
	server.listen(SETTINGS.port, address, () => {
		console.log("mm-configbridge listening on http://" + address + ":" + SETTINGS.port + "/admin (merge helpers: " + merge.loadedFrom + ")");
	});
	// If the Tailscale IP disappears or changes, exit and let systemd restart us.
	if (SETTINGS.bind === "tailscale") {
		setInterval(() => {
			if (!net.addressStillPresent(address)) {
				console.log("mm-configbridge: Tailscale address " + address + " went away, restarting");
				process.exit(1);
			}
		}, 60000).unref();
	}
}

if (require.main === module) {
	main().catch((err) => {
		console.error("mm-configbridge failed to start: " + err.message);
		process.exit(1);
	});
}

module.exports = { prepareOverrides, isSubset, testCalendar, SCHEMAS };
