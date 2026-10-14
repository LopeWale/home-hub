/* Fridge planner config for MagicMirror 2.38 (Raspberry Pi 4, 1920x1080 touch).
 *
 * Rules for this file
 * - MagicMirror replaces every "${NAME}" with the env var NAME from
 *   config/config.env BEFORE evaluating this file. Names starting with
 *   SECRET_ are hidden from the browser ("**SECRET_X**") and restored only
 *   inside the owning module's node_helper. So: never use JS template
 *   literals here, and put every key, iCal URL and password in config.env.
 * - Values editable from the Tailscale admin page live in
 *   config/config.bridge.json and are merged at the bottom of this file.
 * - Page content modules all sit in fullscreen_below (see custom.css).
 */

// Optional features. Flip to true once the hardware or service exists.
const FEATURES = {
	youtubeCast: true, // Phones cast from the YouTube app (MMM-YouTubeCast). See README.
	// Google's photorealistic 3D Earth on the globe page. Needs GOOGLE_MAPS_BROWSER_KEY
	// in config.env (see README). false, or no key, shows the simple globe instead.
	googleEarth: true
};

// Calendar feeds from config.env. A feed whose env var is missing is skipped.
function feed (envName, url, name, color) {
	return process.env[envName] ? { name: name, url: url, color: color } : null;
}

const calendars = [
	feed("SECRET_CAL_FAMILY", "${SECRET_CAL_FAMILY}", "Family", "#33B679"),
	feed("SECRET_CAL_ME", "${SECRET_CAL_ME}", "Me", "#4285F4"),
	feed("SECRET_CAL_PARTNER", "${SECRET_CAL_PARTNER}", "Partner", "#8E24AA"),
	feed("SECRET_CAL_PARTNER_2", "${SECRET_CAL_PARTNER_2}", "Partner (shared)", "#E67C73"),
	// Public feed, not a secret.
	{ name: "US Holidays", url: "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics", color: "#0B8043" }
].filter(Boolean);

let config = {
	address: "localhost", // Electron runs on the Pi itself; nothing else needs port 8080
	port: 8080,
	basePath: "/",
	ipWhitelist: ["127.0.0.1", "::ffff:127.0.0.1", "::1"],
	useHttps: false,
	cors: "disabled", // must not be "allowAll" or SECRET_ restoration is skipped
	language: "en",
	locale: "en-US",
	logLevel: ["INFO", "LOG", "WARN", "ERROR"],
	timeFormat: 12,
	units: "imperial",
	reloadAfterServerRestart: true,
	// A cast must start playing without anyone touching the screen.
	electronSwitches: [{ "autoplay-policy": "no-user-gesture-required" }],
	// MagicMirror opens a transparent window (made for a black mirror). The paper
	// theme needs none, and a transparent window on Wayland can flash black over
	// video, so the window is solid paper colored.
	electronOptions: { transparent: false, backgroundColor: "#f4efe4" },
	// MagicMirror's defaults (js/defaults.js), except the referrer policy: helmet's
	// "no-referrer" hides the page address from Google, and a browser key that is
	// restricted to http://localhost:8080/* is then refused. This sends only the
	// origin (http://localhost:8080/) to other sites.
	httpHeaders: {
		contentSecurityPolicy: false,
		crossOriginOpenerPolicy: false,
		crossOriginEmbedderPolicy: false,
		crossOriginResourcePolicy: false,
		originAgentCluster: false,
		referrerPolicy: { policy: "strict-origin-when-cross-origin" }
	},

	modules: [
		// ---------- controllers (no position) ----------
		{
			module: "MMM-pages",
			config: {
				modules: [
					// Entries are module names or classes; the two dividers are told apart by class.
					["MMM-MyGCalendar", "split-home", "MMM-TodoList"], // 0 Home
					["MMM-YouTubeCast"], // 1 Cast
					["MMM-MyScoreboard", "split-sports", "MMM-GameDetails"], // 2 Sports
					["MMM-GlobeWeatherBridge"] // 3 Globe (weather, air quality, news in its own panel)
				],
				// Setting fixed replaces the default, so MMM-page-indicator is listed again.
				fixed: ["MMM-page-indicator", "MMM-TouchNav", "MMM-BluetoothAudio", "MMM-GuestNet", "MMM-SmartTouch", "MMM-Keyboard"],
				homePage: 0,
				animationTime: 250, // short: two quick taps on the dots during a long fade could leave a page half shown
				timings: { default: 0 }, // no auto rotation
				rotationHomePage: 0
			}
		},
		// ---------- top bar, all pages ----------
		{
			module: "MMM-TouchNav",
			position: "top_left",
			config: {
				pageTitles: ["Home", "Cast", "Sports", "Globe"],
				homePage: 0,
				castPage: 1
			}
		},
		{
			module: "MMM-page-indicator",
			position: "top_center",
			config: { activeBright: true, inactiveDimmed: true, inactiveHollow: true, showPageNumberOnHover: false }
		},
		{
			// Bluetooth icon, left of the network icon. Tap it to pair or connect a
			// speaker; while one is connected all sound (casts too) plays there.
			module: "MMM-BluetoothAudio",
			position: "top_right",
			config: { checkMs: 2 * 60 * 1000 } // the speaker may sleep; a cast wakes it (2026-10-11)
		},
		{
			// Small network icon (Wi-Fi bars or cable). Tap it: guest Wi-Fi QR popup.
			module: "MMM-GuestNet",
			position: "top_right",
			config: {
				// Shown on screen by design, so not secrets. The admin page can override them.
				ssid: "${GUEST_WIFI_SSID}",
				password: "${GUEST_WIFI_PASSWORD}",
				security: "WPA", // WPA (also WPA2/WPA3), WEP or nopass
				showPassword: true
			}
		},
		{
			module: "MMM-SmartTouch",
			position: "top_right"
		},
		{
			module: "MMM-Keyboard",
			position: "fullscreen_above",
			config: { startUppercase: true, sendLabel: "Done" }
		},

		// ---------- page 0: home (calendar | divider | todo) ----------
		{
			module: "MMM-MyGCalendar",
			position: "fullscreen_below",
			order: 1,
			config: {
				calendars: calendars,
				colorRules: [
					// keyword is a case insensitive regex STRING (regex literals do not survive JSON)
					{ keyword: "birthday|bday", color: "#F6BF26" },
					{ keyword: "dentist|doctor|appointment", color: "#D50000" }
				],
				weekStartsOnMonday: false,
				showHeader: true,
				defaultView: "month", // month | week | day; also where it returns after 2 idle minutes
				pastWeekOpacity: 0.55,
				updateInterval: 15 * 60 * 1000
			}
		},
		{
			module: "MMM-SplitLayout",
			classes: "split-home",
			position: "fullscreen_below",
			order: 2,
			config: { initialSplit: 80, minSplit: 50, maxSplit: 90, leftLabel: "calendar", rightLabel: "todo" }
		},
		{
			module: "MMM-TodoList",
			position: "fullscreen_below",
			order: 3,
			config: { members: ["Shopping", "Family", "Me"] }
		},

		// ---------- page 1: cast ----------
		FEATURES.youtubeCast ? {
			module: "MMM-YouTubeCast",
			position: "fullscreen_below",
			order: 1,
			config: {
				deviceName: "Fridge", // name phones show in the YouTube app
				dialPort: 8569, // LAN port for cast discovery
				homePage: 0,
				castPage: 1,
				returnHomeOnStop: true
			}
		} : null,

		// ---------- page 2: sports ----------
		{
			module: "MMM-MyScoreboard",
			position: "fullscreen_below",
			order: 1,
			config: {
				viewStyle: "largeLogos",
				showLeagueSeparators: true,
				colored: true,
				rolloverHours: 3,
				showUpcomingGames: true,
				showPlayoffStatus: true,
				// Set your teams from the admin page. Empty teams = whole league.
				sports: [{ league: "NFL" }, { league: "NBA" }]
			}
		},
		{
			// Drag between the scores and the game details (same divider as the home page).
			module: "MMM-SplitLayout",
			classes: "split-sports",
			position: "fullscreen_below",
			order: 2,
			config: { prefix: "ssl", storageKey: "mmm-splitlayout-sports", initialSplit: 45, minSplit: 30, maxSplit: 75, leftLabel: "scores", rightLabel: "game details" }
		},
		{
			// Right side of the Sports page: tap a game for its details (ESPN).
			module: "MMM-GameDetails",
			position: "fullscreen_below",
			order: 3,
			config: {}
		},

		// ---------- page 3: globe, weather, air quality, news ----------
		{
			module: "MMM-GlobeWeatherBridge",
			position: "fullscreen_below",
			order: 1,
			config: {
				renderer: FEATURES.googleEarth ? "google3d" : "globegl",
				// Browser key for Google's 3D Earth (NOT a SECRET_: the browser must see it).
				// Restrict it in Google Cloud to http://localhost:8080/* and to the
				// Maps JavaScript API + Map Tiles API. Weather, air quality, place names
				// and search use SECRET_GOOGLE_MAPS_KEY on the Pi instead.
				browserKey: "${GOOGLE_MAPS_BROWSER_KEY}",
				// Home: coordinates, else the address, else found automatically (Wi-Fi, then internet).
				// All three may be left empty; the admin page can set or correct home later.
				home: { label: "Home", address: "${HOME_ADDRESS}", lat: Number("${HOME_LAT}"), lng: Number("${HOME_LNG}") },
				autoLocate: true,
				pins: [],
				geocoder: "google", // falls back to Open-Meteo (place names only) without SECRET_GOOGLE_MAPS_KEY
				units: "imperial",
				weatherRefreshMin: 30, // 3 Weather API calls per refresh; 30 min keeps inside Google's free 10,000/month
				autoRotate: true, // simple globe only
				maxFps: 30 // simple globe only
			}
		}
	].filter(Boolean)
};

/* ---------- config bridge overrides ----------
 * mm-configbridge writes config/config.bridge.json. Secrets in it are
 * "**SECRET_BRIDGE_X**" placeholders with values in config.env.
 * MagicMirror evaluates this file twice: once for the server (full) and once
 * for the browser (redacted). The marker below is "1" only in the full pass,
 * so placeholders are resolved on the server and stay hidden in the browser.
 */
const MM_FULL_PASS = "${SECRET_MM_FULL_PASS}" === "1";
try {
	const path = require("node:path");
	const configDir = path.join(global.root_path || process.cwd(), "config");
	require(path.join(configDir, "mm-bridge-merge.js")).applyBridgeFile(config, path.join(configDir, "config.bridge.json"), { resolve: MM_FULL_PASS });
} catch (err) {
	console.error("[config.bridge] merge helper unavailable, using base config: " + err.message);
}

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }
