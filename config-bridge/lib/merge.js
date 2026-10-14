"use strict";

/*
 * Loads the shared merge helpers. Prefer the copy MagicMirror itself uses,
 * so the bridge and config.js can never disagree about merge rules.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const candidates = [
	path.join(process.env.MM_DIR || path.join(os.homedir(), "MagicMirror"), "config", "mm-bridge-merge.js"),
	path.join(__dirname, "mm-bridge-merge.js"), // copy placed by install.sh
	path.join(__dirname, "..", "..", "config", "mm-bridge-merge.js") // repo layout
];

const found = candidates.find((file) => fs.existsSync(file));
if (!found) throw new Error("mm-bridge-merge.js not found in: " + candidates.join(", "));

module.exports = require(found);
module.exports.loadedFrom = found;
