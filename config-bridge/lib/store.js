"use strict";

/*
 * File access for the bridge: config.bridge.json, config.env, backups.
 * Backups live OUTSIDE MagicMirror's config/ folder because MagicMirror
 * serves that folder over HTTP (only config.js and config.env are blocked,
 * see js/server.js in MagicMirror 2.38).
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

async function readText (file) {
	try {
		return await fs.readFile(file, "utf-8");
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}

/** Write via temp file + fsync + rename so readers never see a half file. */
async function writeAtomic (file, content, mode = 0o644) {
	const dir = path.dirname(file);
	const tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp");
	const handle = await fs.open(tmp, "w", mode);
	try {
		await handle.writeFile(content, "utf-8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.chmod(tmp, mode);
	await fs.rename(tmp, file);
	try {
		const dirHandle = await fs.open(dir, "r");
		await dirHandle.sync();
		await dirHandle.close();
	} catch {
		// directory fsync is best effort
	}
}

function revisionOf (text) {
	if (text === null) return "none";
	return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function stamp () {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

class Store {
	constructor ({ mmConfigDir, stateDir, keepBackups = 30 }) {
		this.bridgeFile = path.join(mmConfigDir, "config.bridge.json");
		this.envFile = path.join(mmConfigDir, "config.env");
		this.backupDir = path.join(stateDir, "backups");
		this.keepBackups = keepBackups;
	}

	async init () {
		await fs.mkdir(this.backupDir, { recursive: true, mode: 0o700 });
	}

	async readBridge () {
		const text = await readText(this.bridgeFile);
		const data = text === null || text.trim() === "" ? {} : JSON.parse(text);
		return { text, data, revision: revisionOf(text) };
	}

	async readEnv () {
		const text = await readText(this.envFile);
		return text === null ? "" : text;
	}

	/** Copy current files to the backup dir. Returns the backup id. */
	async backup () {
		const id = stamp();
		const bridgeText = await readText(this.bridgeFile);
		const envText = await readText(this.envFile);
		const record = { id, bridge: bridgeText, env: envText };
		await writeAtomic(path.join(this.backupDir, "backup-" + id + ".json"), JSON.stringify(record), 0o600);
		// Human friendly copy (config.bridge.json.<id>.bak). Never contains secrets.
		if (bridgeText !== null) {
			await writeAtomic(path.join(this.backupDir, "config.bridge.json." + id + ".bak"), bridgeText, 0o600);
		}
		await this.prune();
		return id;
	}

	async restore (id) {
		if (!/^[0-9TZ-]+$/.test(id)) throw new Error("bad backup id");
		const raw = await fs.readFile(path.join(this.backupDir, "backup-" + id + ".json"), "utf-8");
		const record = JSON.parse(raw);
		if (record.bridge === null) await fs.rm(this.bridgeFile, { force: true });
		else await writeAtomic(this.bridgeFile, record.bridge, 0o644);
		if (record.env === null) await fs.rm(this.envFile, { force: true });
		else await writeAtomic(this.envFile, record.env, 0o600);
	}

	async listBackups () {
		const names = await fs.readdir(this.backupDir).catch(() => []);
		return names.filter((n) => n.startsWith("backup-") && n.endsWith(".json")).map((n) => n.slice(7, -5)).sort().reverse();
	}

	async prune () {
		const ids = await this.listBackups();
		for (const id of ids.slice(this.keepBackups)) {
			await fs.rm(path.join(this.backupDir, "backup-" + id + ".json"), { force: true });
			await fs.rm(path.join(this.backupDir, "config.bridge.json." + id + ".bak"), { force: true });
		}
	}

	async writeBridge (data) {
		await writeAtomic(this.bridgeFile, JSON.stringify(data, null, 2) + "\n", 0o644);
	}

	async writeEnv (text) {
		await writeAtomic(this.envFile, text, 0o600);
	}
}

module.exports = { Store, writeAtomic, revisionOf };
