/* MMM-TouchNav
 *
 * Page helpers for MMM-pages (edward-shen, v1.5.x API). The page dots
 * (MMM-page-indicator) are the navigation; this module adds:
 *   - the current page title in the top bar
 *   - optional horizontal swipe outside interactive areas (not on the
 *     calendar, where a swipe changes the month)
 *   - closes open MMM-MyGCalendar modals when the page changes
 *     (they live on document.body and would otherwise float over the next page)
 *   - optional return to the home page after the fridge has been left alone
 *
 * Sends: PAGE_SELECT, PAGE_INCREMENT, PAGE_DECREMENT (swipe)
 * Listens: NEW_PAGE, MAX_PAGES_CHANGED, YOUTUBE_CAST_STARTED / _STOPPED (MMM-YouTubeCast)
 */
Module.register("MMM-TouchNav", {
	defaults: {
		pageTitles: ["Home", "Cast", "Sports", "Globe"],
		homePage: 0,
		castPage: 1,
		idleCheckMs: 15 * 1000, // how often shouldReturnHome() is asked
		swipe: true,
		swipeMinDistance: 120, // px of horizontal travel
		swipeMaxOffAxis: 80, // px of vertical drift allowed
		swipeMaxMs: 700,
		// Swipes that start inside these never change page.
		noSwipeSelectors: [".MMM-GlobeWeatherBridge", ".MMM-MyGCalendar", ".msl-handle", ".MMM-Keyboard", "#kbContainer", ".gcal-modal-backdrop", ".gcal-picker-backdrop", ".gn-backdrop", ".bta-backdrop", "input", "textarea", "select", "[data-no-swipe]"]
	},

	getStyles () {
		return ["MMM-TouchNav.css"];
	},

	start () {
		this.page = this.config.homePage;
		this.maxPages = this.config.pageTitles.length;
		this.lastActivity = Date.now();
		this.pageSince = Date.now();
		this.casting = false;
	},

	/**
	 * Called every idleCheckMs. Return true to jump back to the home page.
	 * @param {object} ctx
	 * @param {number} ctx.page current page index
	 * @param {number} ctx.homePage home page index
	 * @param {number} ctx.castPage cast page index
	 * @param {number} ctx.idleMs ms since the last touch anywhere on the screen
	 * @param {number} ctx.onPageMs ms since the current page was opened
	 * @param {boolean} ctx.casting a YouTube cast is running (MMM-YouTubeCast)
	 * @param {boolean} ctx.keyboardOpen the on screen keyboard is showing
	 * @param {boolean} ctx.popupOpen a calendar or guest Wi-Fi popup is open
	 * @returns {boolean}
	 */
	shouldReturnHome (ctx) {
		// TODO(human): decide when the fridge should go back to the home page.
		return false;
	},

	checkIdle () {
		const now = Date.now();
		const ctx = {
			page: this.page,
			homePage: this.config.homePage,
			castPage: this.config.castPage,
			idleMs: now - this.lastActivity,
			onPageMs: now - this.pageSince,
			casting: this.casting,
			keyboardOpen: Boolean(document.querySelector(".kbContainer.show-keyboard")),
			popupOpen: Boolean(document.querySelector(".gcal-modal-backdrop.gcal-visible, .gcal-picker-backdrop, .gn-backdrop, .bta-backdrop"))
		};
		let goHome = false;
		try {
			goHome = this.shouldReturnHome(ctx) === true;
		} catch (err) {
			Log.error("MMM-TouchNav: shouldReturnHome failed: " + err.message);
		}
		if (goHome && this.page !== this.config.homePage) {
			this.closeOverlays();
			this.sendNotification("PAGE_SELECT", this.config.homePage);
		}
	},

	notificationReceived (notification, payload) {
		if (notification === "NEW_PAGE" && Number.isInteger(payload)) {
			if (payload !== this.page) {
				this.closeOverlays();
				this.pageSince = Date.now();
			}
			this.page = payload;
			this.refresh();
		} else if (notification === "MAX_PAGES_CHANGED" && Number.isInteger(payload)) {
			this.maxPages = payload;
			this.refresh();
		} else if (notification === "YOUTUBE_CAST_STARTED") {
			this.casting = true;
		} else if (notification === "YOUTUBE_CAST_STOPPED") {
			this.casting = false;
		} else if (notification === "DOM_OBJECTS_CREATED") {
			if (this.config.swipe) this.bindSwipe();
			// isTrusted skips the synthetic Escape that closeOverlays() sends.
			const touched = (ev) => {
				if (ev.isTrusted) this.lastActivity = Date.now();
			};
			document.addEventListener("pointerdown", touched, { passive: true, capture: true });
			document.addEventListener("keydown", touched, { passive: true, capture: true });
			setInterval(() => this.checkIdle(), this.config.idleCheckMs);
		}
	},

	closeOverlays () {
		// The calendar popups, the month picker and the guest Wi-Fi popup close on Escape.
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	},

	getDom () {
		const bar = document.createElement("div");
		bar.className = "mtn-bar";
		this.titleEl = document.createElement("span");
		this.titleEl.className = "mtn-title";
		bar.appendChild(this.titleEl);
		this.refresh();
		return bar;
	},

	refresh () {
		if (this.titleEl) this.titleEl.textContent = this.config.pageTitles[this.page] || "Page " + (this.page + 1);
	},

	bindSwipe () {
		if (this.swipeBound) return;
		this.swipeBound = true;
		let start = null;
		document.addEventListener("pointerdown", (ev) => {
			if (ev.pointerType === "mouse" && ev.button !== 0) return;
			const blocked = this.config.noSwipeSelectors.some((sel) => {
				try {
					return ev.target.closest(sel);
				} catch {
					return false;
				}
			});
			start = blocked ? null : { x: ev.clientX, y: ev.clientY, t: Date.now(), id: ev.pointerId };
		}, { passive: true });
		document.addEventListener("pointerup", (ev) => {
			if (!start || ev.pointerId !== start.id) return;
			const dx = ev.clientX - start.x;
			const dy = Math.abs(ev.clientY - start.y);
			const dt = Date.now() - start.t;
			start = null;
			if (Math.abs(dx) < this.config.swipeMinDistance || dy > this.config.swipeMaxOffAxis || dt > this.config.swipeMaxMs) return;
			this.sendNotification(dx < 0 ? "PAGE_INCREMENT" : "PAGE_DECREMENT", 1);
		}, { passive: true });
		document.addEventListener("pointercancel", () => {
			start = null;
		}, { passive: true });
	}
});
