/* Fridge Mirror Admin: schema driven forms over the bridge API.
 * No framework, no inline scripts (the page is served with a strict CSP).
 * Never logs field values: calendar URLs are passwords. */
"use strict";

(() => {
	const TOKEN_KEY = "mmBridgeToken";
	const PLACEHOLDER_RE = /^\*\*(SECRET_[A-Z0-9_]+)\*\*$/;
	const $ = (id) => document.getElementById(id);

	let token = "";
	let state = null; // last /api/config/get response
	let forms = {}; // module name -> { get(), initial }
	let polling = null;

	// ---------- token ----------

	function storedToken () {
		try {
			return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
		} catch {
			return "";
		}
	}

	function storeToken (value, remember) {
		try {
			(remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, value);
		} catch {
			// storage blocked, keep it in memory only
		}
	}

	function forgetToken () {
		try {
			localStorage.removeItem(TOKEN_KEY);
			sessionStorage.removeItem(TOKEN_KEY);
		} catch {
			// ignore
		}
		token = "";
	}

	// ---------- api ----------

	async function api (route, body = {}) {
		const res = await fetch(route, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
			body: JSON.stringify(body),
			credentials: "same-origin",
			cache: "no-store"
		});
		let data = {};
		try {
			data = await res.json();
		} catch {
			// non JSON error page
		}
		if (res.status === 401) {
			forgetToken();
			showLogin("Token rejected.");
			throw new Error("unauthorized");
		}
		if (!res.ok && res.status !== 202) {
			const err = new Error(data.error || "HTTP " + res.status);
			err.details = data.details || [];
			throw err;
		}
		return data;
	}

	// ---------- small DOM helpers ----------

	function el (tag, attrs = {}, ...children) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs)) {
			if (key === "class") node.className = value;
			else if (key === "text") node.textContent = value;
			else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
			else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
		}
		for (const child of children.flat()) if (child) node.append(child);
		return node;
	}

	function labelFor (schema, key) {
		return schema.title || key;
	}

	// ---------- field renderers: each returns { el, get } ----------

	function renderField (schema, value, key, onChange) {
		if (schema.type === "object") return renderObject(schema, value || {}, key, onChange);
		if (schema.type === "array") return renderArray(schema, Array.isArray(value) ? value : [], key, onChange);
		if (schema.type === "boolean") {
			const input = el("input", { type: "checkbox", onchange: onChange });
			input.checked = Boolean(value);
			return { el: el("label", { class: "field inline" }, input, el("span", { text: labelFor(schema, key) })), get: () => input.checked };
		}
		if (schema.type === "integer" || schema.type === "number") {
			const input = el("input", { type: "number", step: schema.type === "integer" ? "1" : "any", min: schema.minimum, max: schema.maximum, oninput: onChange });
			if (typeof value === "number") input.value = String(value);
			return {
				el: el("label", { class: "field" }, el("span", { text: labelFor(schema, key) }), input),
				get: () => (input.value.trim() === "" ? undefined : Number(input.value))
			};
		}
		if (schema.enum) {
			const emptyLabel = schema["x-empty-label"] || "(module default)";
			const select = el("select", { onchange: onChange }, el("option", { value: "", text: emptyLabel }), schema.enum.map((opt) => el("option", { value: opt, text: opt })));
			select.value = value === undefined ? "" : String(value);
			return { el: el("label", { class: "field" }, el("span", { text: labelFor(schema, key) }), select), get: () => (select.value === "" ? undefined : select.value) };
		}
		if (schema["x-widget"] === "color") return renderColor(schema, value, key, onChange);
		if (schema["x-widget"] === "secret-url") return renderSecret(schema, value, key, onChange);
		const input = el("input", { type: schema["x-widget"] === "password" ? "password" : "text", autocomplete: "off", spellcheck: "false", maxlength: schema.maxLength, oninput: onChange });
		input.value = value === undefined || value === null ? "" : String(value);
		const wrap = el("label", { class: "field" }, el("span", { text: labelFor(schema, key) }), input);
		if (schema["x-widget"] === "password") {
			wrap.append(el("button", { type: "button", class: "small", text: "Show", onclick: (ev) => {
				input.type = input.type === "password" ? "text" : "password";
				ev.target.textContent = input.type === "password" ? "Show" : "Hide";
			} }));
		}
		return { el: wrap, get: () => (input.value === "" && value === undefined ? undefined : input.value) };
	}

	function renderObject (schema, value, key, onChange) {
		const parts = Object.entries(schema.properties || {}).map(([childKey, childSchema]) => [childKey, renderField(childSchema, value[childKey], childKey, onChange)]);
		const body = parts.map(([, part]) => part.el);
		const node = key ? el("fieldset", {}, el("legend", { text: labelFor(schema, key) }), body) : el("div", {}, body);
		return {
			el: node,
			get: () => {
				const out = {};
				for (const [childKey, part] of parts) {
					const v = part.get();
					if (v !== undefined) out[childKey] = v;
				}
				return out;
			}
		};
	}

	function renderArray (schema, value, key, onChange) {
		const rows = [];
		const list = el("div", { class: "rows" });
		const itemSchema = schema.items || { type: "string" };

		const blank = () => {
			if (itemSchema.type === "object") {
				const obj = {};
				for (const [k, s] of Object.entries(itemSchema.properties || {})) if (s.default !== undefined) obj[k] = s.default;
				return obj;
			}
			return itemSchema.type === "string" ? "" : undefined;
		};

		const redraw = () => {
			list.replaceChildren(...rows.map((row) => row.el));
			rows.forEach((row, i) => {
				row.up.disabled = i === 0;
				row.down.disabled = i === rows.length - 1;
			});
		};

		const addRow = (itemValue) => {
			const field = itemSchema.type === "object" ? renderObjectRow(itemSchema, itemValue || {}, onChange) : renderField(itemSchema, itemValue, "", onChange);
			const row = { field };
			row.up = el("button", { type: "button", class: "small", title: "Move up", text: "↑", onclick: () => move(row, -1) });
			row.down = el("button", { type: "button", class: "small", title: "Move down", text: "↓", onclick: () => move(row, 1) });
			const del = el("button", { type: "button", class: "small danger", title: "Remove", text: "✕", onclick: () => {
				rows.splice(rows.indexOf(row), 1);
				redraw();
				onChange();
			} });
			row.el = el("div", { class: "row" }, el("div", { class: "row-fields" }, field.el), el("div", { class: "row-actions" }, row.up, row.down, del));
			rows.push(row);
		};

		const move = (row, delta) => {
			const i = rows.indexOf(row);
			const j = i + delta;
			if (j < 0 || j >= rows.length) return;
			[rows[i], rows[j]] = [rows[j], rows[i]];
			redraw();
			onChange();
		};

		value.forEach(addRow);
		redraw();
		const add = el("button", { type: "button", class: "small", text: "+ Add", onclick: () => {
			if (schema.maxItems && rows.length >= schema.maxItems) return;
			addRow(blank());
			redraw();
			onChange();
		} });
		return {
			el: el("fieldset", {}, el("legend", { text: labelFor(schema, key) }), list, add),
			get: () => rows.map((row) => row.field.get()).filter((v) => v !== undefined)
		};
	}

	function renderObjectRow (schema, value, onChange) {
		const parts = [];
		const sibling = (name) => {
			const found = parts.find(([k]) => k === name);
			return found ? found[1].get() : undefined;
		};
		for (const [k, s] of Object.entries(schema.properties || {})) {
			parts.push([k, s["x-widget"] === "team-picker" ? renderTeamPicker(s, value[k], k, onChange, () => sibling(s["x-league-field"] || "league")) : renderField(s, value[k], k, onChange)]);
		}
		const node = el("div", { class: "row-fields" }, parts.map(([, p]) => p.el));
		node.addEventListener("change", () => {
			for (const [, p] of parts) if (p.onSiblingChange) p.onSiblingChange();
		});
		return {
			el: node,
			get: () => {
				const out = {};
				for (const [k, p] of parts) {
					const v = p.get();
					if (v !== undefined && !(Array.isArray(v) && v.length === 0 && value[k] === undefined)) out[k] = v;
				}
				return out;
			}
		};
	}

	/* Teams for MMM-MyScoreboard: chips plus a search box over ESPN's team list for
	 * the league picked in the same row. Codes are ESPN abbreviations (OU, DUKE).
	 * Leagues ESPN does not serve fall back to typing a code. */
	const teamLists = new Map(); // league -> Promise<{ supported, teams }>

	function loadTeams (league) {
		if (!teamLists.has(league)) {
			const p = api("/api/teams", { league }).catch((err) => {
				teamLists.delete(league);
				return { supported: false, teams: [], error: err.message };
			});
			teamLists.set(league, p);
		}
		return teamLists.get(league);
	}

	function renderTeamPicker (schema, value, key, onChange, getLeague) {
		let picked = Array.isArray(value) ? value.slice() : [];
		let list = { supported: false, teams: [] };
		let loadedFor = null;
		const chips = el("div", { class: "chips" });
		const search = el("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "Type a team name or code" });
		const results = el("div", { class: "team-results" });
		const note = el("div", { class: "hint" });

		const nameOf = (abbr) => {
			const hits = list.teams.filter((t) => t.abbr === abbr);
			return hits.length ? hits.map((t) => t.name).join(" / ") : null;
		};

		const drawChips = () => {
			chips.replaceChildren(...picked.map((abbr, i) => {
				const name = nameOf(abbr);
				const bad = list.supported && !name;
				return el("span", { class: "chip" + (bad ? " chip-bad" : ""), title: bad ? "Not a team code in this league" : abbr },
					el("span", { text: name ? name + " (" + abbr + ")" : abbr + (bad ? " (unknown code)" : "") }),
					el("button", { type: "button", class: "chip-x", title: "Remove", text: "\u2715", onclick: () => {
						picked.splice(i, 1);
						drawChips();
						onChange();
					} }));
			}));
			if (!picked.length) chips.append(el("span", { class: "hint", text: "No teams: the whole league is shown." }));
		};

		const add = (abbr) => {
			const code = String(abbr).trim();
			if (!code || picked.includes(code) || (schema.maxItems && picked.length >= schema.maxItems)) return;
			picked.push(code);
			search.value = "";
			results.replaceChildren();
			drawChips();
			onChange();
		};

		const drawResults = () => {
			const q = search.value.trim().toLowerCase();
			if (!list.supported) {
				results.replaceChildren(q ? el("button", { type: "button", class: "small", text: "Add code \u201c" + search.value.trim() + "\u201d", onclick: () => add(search.value) }) : "");
				return;
			}
			if (q.length < 2) {
				results.replaceChildren();
				return;
			}
			const hits = list.teams.filter((t) => t.name.toLowerCase().includes(q) || t.abbr.toLowerCase() === q).slice(0, 12);
			results.replaceChildren(...(hits.length ? hits.map((t) => el("button", { type: "button", class: "team-hit", text: t.name + " (" + t.abbr + ")", onclick: () => add(t.abbr) })) : [el("span", { class: "hint", text: "No team matches." })]));
		};

		const refresh = async () => {
			const league = getLeague();
			if (league === loadedFor) return;
			loadedFor = league;
			if (!league) {
				list = { supported: false, teams: [] };
				note.textContent = "Pick a league first.";
			} else {
				note.textContent = "Loading " + league + " teams\u2026";
				list = await loadTeams(league);
				if (loadedFor !== league) return;
				note.textContent = list.supported
					? list.teams.length + " " + league + " teams. Type part of a name, then tap the team."
					: (list.error ? list.error + ". " : "") + league + " team names are not available here: type the team code and tap Add.";
			}
			drawChips();
			drawResults();
		};

		search.addEventListener("input", drawResults);
		search.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				const first = results.querySelector("button");
				if (first) first.click();
			}
		});
		drawChips();
		refresh();
		return {
			el: el("fieldset", { class: "team-picker" }, el("legend", { text: labelFor(schema, key) }), chips, search, results, note),
			get: () => picked.slice(),
			onSiblingChange: refresh
		};
	}

	function renderColor (schema, value, key, onChange) {
		const start = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : schema.default || "#4285f4";
		const picker = el("input", { type: "color" });
		const text = el("input", { type: "text", maxlength: 7, spellcheck: "false" });
		picker.value = start.toLowerCase();
		text.value = typeof value === "string" ? value : start;
		picker.addEventListener("input", () => {
			text.value = picker.value;
			onChange();
		});
		text.addEventListener("input", () => {
			if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value.toLowerCase();
			onChange();
		});
		return { el: el("label", { class: "field" }, el("span", { text: labelFor(schema, key) }), el("div", { class: "color" }, picker, text)), get: () => text.value.trim() };
	}

	/* Stored secrets arrive as **SECRET_X** placeholders. The input stays
	 * empty (masked) unless the user reveals or replaces it. */
	function renderSecret (schema, value, key, onChange) {
		const stored = typeof value === "string" && PLACEHOLDER_RE.test(value) ? value : null;
		const input = el("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: stored ? "stored secret, unchanged" : "https://...ics", oninput: onChange });
		if (!stored && typeof value === "string") input.value = value;
		let revealed = null;
		const result = el("span", { class: "result" });
		const reveal = el("button", { type: "button", class: "small", text: "Reveal", onclick: async () => {
			if (input.type === "text") {
				input.type = "password";
				reveal.textContent = "Reveal";
				return;
			}
			if (stored && revealed === null) {
				try {
					revealed = (await api("/api/secret/reveal", { placeholder: stored })).value;
					input.value = revealed;
				} catch (err) {
					result.className = "result error";
					result.textContent = err.message;
					return;
				}
			}
			input.type = "text";
			reveal.textContent = "Hide";
		} });
		const controls = [input, reveal];
		if (schema["x-test"] === "calendar") {
			controls.push(el("button", { type: "button", class: "small", text: "Test", onclick: async () => {
				result.className = "result muted";
				result.textContent = "Testing...";
				const typed = input.value.trim();
				const url = typed && typed !== revealed ? typed : stored || typed;
				try {
					const r = await api("/api/test-calendar", { url });
					result.className = "result " + (r.ok ? "ok" : "error");
					result.textContent = r.message;
				} catch (err) {
					result.className = "result error";
					result.textContent = err.message;
				}
			} }));
		}
		return {
			el: el("label", { class: "field" }, el("span", { text: labelFor(schema, key) }), el("div", { class: "secret" }, controls), result),
			get: () => {
				const typed = input.value.trim();
				if (stored && (typed === "" || typed === revealed)) return stored;
				return typed;
			}
		};
	}

	// ---------- page ----------

	function snapshot () {
		const out = {};
		for (const [name, form] of Object.entries(forms)) out[name] = form.get();
		return out;
	}

	function changedModules () {
		const out = {};
		for (const [name, form] of Object.entries(forms)) {
			const now = form.get();
			if (JSON.stringify(now) !== form.initial) out[name] = now;
		}
		return out;
	}

	function updateSaveBar () {
		const n = Object.keys(changedModules()).length;
		$("save").disabled = n === 0 || Boolean(polling);
		$("discard").disabled = n === 0 || Boolean(polling);
		if (!polling) $("save-status").textContent = n === 0 ? "No changes" : n + " section(s) changed";
	}

	function render () {
		const container = $("sections");
		container.replaceChildren();
		forms = {};
		for (const [name, schema] of Object.entries(state.schemas)) {
			const mod = state.modules[name] || { installed: false, values: {} };
			const form = renderField(schema.config, mod.values, "", updateSaveBar);
			forms[name] = form;
			const section = el("section", { class: "module" + (mod.installed ? "" : " not-installed") },
				el("h2", { text: schema.title || name }),
				el("p", { class: "desc", text: (mod.installed ? "" : "Not enabled in config.js. Changes are stored but have no effect. ") + (schema.description || "") }),
				form.el);
			container.append(section);
		}
		for (const form of Object.values(forms)) form.initial = JSON.stringify(form.get());
		$("savebar").classList.remove("hidden");
		updateSaveBar();
	}

	function setMirrorPill (up) {
		const pill = $("mirror-state");
		pill.textContent = up ? "mirror live" : "mirror offline";
		pill.className = "pill " + (up ? "up" : "down");
	}

	async function load () {
		state = await api("/api/config/get");
		setMirrorPill(state.live);
		if (state.lastSaved) $("last-saved").textContent = "Last saved " + new Date(state.lastSaved).toLocaleString();
		render();
	}

	const PHASE_TEXT = {
		validating: "Validating",
		saved: "Saved",
		checking: "Checking config",
		reloading: "Reloading mirror",
		live: "Live",
		restored: "Failed, previous config restored",
		failed: "Failed"
	};

	function pollStatus () {
		polling = setInterval(async () => {
			try {
				const s = await api("/api/status");
				setMirrorPill(s.mirrorUp);
				const job = s.job;
				if (!job) return;
				const status = $("save-status");
				status.textContent = (PHASE_TEXT[job.phase] || job.phase) + (job.message ? ": " + job.message : "");
				status.className = job.phase === "live" ? "ok" : ["failed", "restored"].includes(job.phase) ? "error" : "warn";
				if (job.finishedAt) {
					clearInterval(polling);
					polling = null;
					if (job.phase === "live") $("last-saved").textContent = "Last saved " + new Date(job.finishedAt).toLocaleString();
					await load();
					status.textContent = (PHASE_TEXT[job.phase] || job.phase) + (job.message ? ": " + job.message : "");
				}
			} catch {
				// mirror restarting or network blip, keep polling
			}
		}, 2000);
	}

	async function save () {
		const modules = changedModules();
		if (Object.keys(modules).length === 0) return;
		const status = $("save-status");
		status.className = "warn";
		status.textContent = "Saving...";
		try {
			await api("/api/config", { revision: state.revision, modules });
			updateSaveBar();
			pollStatus();
			updateSaveBar();
		} catch (err) {
			status.className = "error";
			status.textContent = err.message + (err.details && err.details.length ? ": " + err.details.join("; ") : "");
		}
	}

	function showLogin (message) {
		$("login").classList.remove("hidden");
		$("logout").classList.add("hidden");
		$("savebar").classList.add("hidden");
		$("sections").replaceChildren();
		$("login-error").textContent = message || "";
	}

	async function start () {
		token = storedToken();
		if (!token) return showLogin();
		$("login").classList.add("hidden");
		$("logout").classList.remove("hidden");
		try {
			await load();
		} catch (err) {
			if (err.message !== "unauthorized") $("sections").replaceChildren(el("p", { class: "card error", text: "Could not load config: " + err.message }));
		}
	}

	document.addEventListener("DOMContentLoaded", () => {
		$("login-form").addEventListener("submit", (ev) => {
			ev.preventDefault();
			token = $("token").value.trim();
			storeToken(token, $("remember").checked);
			$("token").value = "";
			start();
		});
		$("logout").addEventListener("click", () => {
			forgetToken();
			showLogin();
		});
		$("save").addEventListener("click", save);
		$("discard").addEventListener("click", () => render());
		window.addEventListener("beforeunload", (ev) => {
			if (state && Object.keys(changedModules()).length > 0) ev.preventDefault();
		});
		start();
	});

	// exposed for debugging in the console without leaking values
	window.mmBridgeAdmin = { changedModuleNames: () => Object.keys(changedModules()), snapshotKeys: () => Object.keys(snapshot()) };
})();
