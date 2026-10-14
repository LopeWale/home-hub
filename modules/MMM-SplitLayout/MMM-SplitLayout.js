/* MMM-SplitLayout
 *
 * Divider between two modules that share the fullscreen_below region.
 * The layout itself lives in config/custom.css (static 80:20 fallback).
 * This module only writes the CSS variable --msl-split and the
 * msl-collapsed-* classes on <html>, so if this file fails to load the
 * page still renders a fixed 80:20 split.
 *
 * Place it in the same region as the two panes, with an `order` between
 * them, for example: calendar order 1, MMM-SplitLayout order 2, todo order 3.
 *
 * Several dividers can exist (home page, sports page): each gets its own
 * `prefix`, so it writes --<prefix>-split and <prefix>-collapsed-* and never
 * touches another page's layout. Give each a unique `classes` too, so
 * MMM-pages can put each on its own page.
 */
Module.register("MMM-SplitLayout", {
	defaults: {
		initialSplit: 80, // percent of width given to the left pane
		minSplit: 50, // clamp while dragging (50:50)
		maxSplit: 90, // clamp while dragging (90:10)
		storageKey: "mmm-splitlayout",
		prefix: "msl", // CSS variable and class prefix (see config/custom.css)
		showButtons: true,
		leftLabel: "Calendar",
		rightLabel: "Todo"
	},

	getStyles () {
		return ["font-awesome.css", "MMM-SplitLayout.css"];
	},

	start () {
		this.state = this.loadState();
		this.applyState();
	},

	// ---------- state ----------

	clamp (pct) {
		return Math.min(this.config.maxSplit, Math.max(this.config.minSplit, pct));
	},

	loadState () {
		const fallback = { mode: "split", percent: this.config.initialSplit };
		try {
			const raw = window.localStorage.getItem(this.config.storageKey);
			if (!raw) return fallback;
			const saved = JSON.parse(raw);
			const modes = ["split", "collapsed-left", "collapsed-right"];
			if (!modes.includes(saved.mode) || typeof saved.percent !== "number") return fallback;
			return { mode: saved.mode, percent: this.clamp(saved.percent) };
		} catch {
			return fallback;
		}
	},

	saveState () {
		try {
			window.localStorage.setItem(this.config.storageKey, JSON.stringify(this.state));
		} catch {
			// localStorage unavailable: the split still works for this session.
		}
	},

	applyState () {
		const root = document.documentElement;
		const p = this.config.prefix;
		root.style.setProperty("--" + p + "-split", this.state.percent + "%");
		// collapsed-right means the right pane is collapsed, the left pane gets 100%.
		root.classList.toggle(p + "-collapsed-right", this.state.mode === "collapsed-right");
		root.classList.toggle(p + "-collapsed-left", this.state.mode === "collapsed-left");
		if (this.buttons) {
			this.buttons.left.classList.toggle("msl-active", this.state.mode === "collapsed-right");
			this.buttons.right.classList.toggle("msl-active", this.state.mode === "collapsed-left");
		}
	},

	setMode (mode) {
		this.state.mode = mode;
		this.applyState();
		this.saveState();
	},

	/**
	 * Decide the final layout when the user lifts their finger off the handle.
	 * @param {number} rawPercent where the finger was released, 0..100 of the container width (not clamped)
	 * @returns {{mode: string, percent: number}} new state
	 */
	resolveDragEnd (rawPercent) {
		return { mode: "split", percent: this.clamp(rawPercent) };
	},

	// ---------- DOM ----------

	getDom () {
		const divider = document.createElement("div");
		divider.className = "msl-divider";

		const handle = document.createElement("div");
		handle.className = "msl-handle";
		handle.setAttribute("role", "separator");
		handle.setAttribute("aria-orientation", "vertical");
		handle.innerHTML = "<span class=\"msl-grip\"></span>";
		divider.appendChild(handle);

		if (this.config.showButtons) {
			const bar = document.createElement("div");
			bar.className = "msl-buttons";
			const left = this.makeButton("fa-angles-right", "Expand " + this.config.leftLabel, () => {
				this.setMode(this.state.mode === "collapsed-right" ? "split" : "collapsed-right");
			});
			const reset = this.makeButton("fa-arrows-left-right", "Reset " + this.config.initialSplit + ":" + (100 - this.config.initialSplit), () => {
				this.state.percent = this.config.initialSplit;
				this.setMode("split");
			});
			const right = this.makeButton("fa-angles-left", "Expand " + this.config.rightLabel, () => {
				this.setMode(this.state.mode === "collapsed-left" ? "split" : "collapsed-left");
			});
			bar.append(left, reset, right);
			divider.appendChild(bar);
			this.buttons = { left, reset, right };
		}

		this.bindDrag(handle);
		this.applyState();
		return divider;
	},

	makeButton (icon, label, onTap) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "msl-btn";
		btn.title = label;
		btn.setAttribute("aria-label", label);
		btn.innerHTML = "<i class=\"fa-solid " + icon + "\"></i>";
		btn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			onTap();
		});
		return btn;
	},

	bindDrag (handle) {
		let dragging = false;
		let lastRaw = this.state.percent;
		const root = document.documentElement;

		const percentFromEvent = (ev) => {
			// The flex container is the region .container that holds both panes.
			const container = handle.closest(".container") || document.body;
			const rect = container.getBoundingClientRect();
			if (rect.width <= 0) return this.state.percent;
			return ((ev.clientX - rect.left) / rect.width) * 100;
		};

		handle.addEventListener("pointerdown", (ev) => {
			ev.preventDefault();
			dragging = true;
			try {
				handle.setPointerCapture(ev.pointerId);
			} catch {
				// pointer capture not supported, moves outside the handle are lost
			}
			root.classList.add(this.config.prefix + "-dragging");
			// Dragging always leaves collapsed mode.
			this.state.mode = "split";
			lastRaw = percentFromEvent(ev);
			this.state.percent = this.clamp(lastRaw);
			this.applyState();
		});

		handle.addEventListener("pointermove", (ev) => {
			if (!dragging) return;
			lastRaw = percentFromEvent(ev);
			this.state.percent = this.clamp(lastRaw);
			this.applyState();
		});

		const end = () => {
			if (!dragging) return;
			dragging = false;
			root.classList.remove(this.config.prefix + "-dragging");
			this.state = this.resolveDragEnd(lastRaw);
			this.applyState();
			this.saveState();
		};
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
		handle.addEventListener("lostpointercapture", end);
	}
});
