/* MMM-Guard. Its node_helper restarts MagicMirror when the page or GPU process
 * crashes or the page hangs (see guard.js), and checks the SD card, power and
 * free space (see health.js). This part only draws a warning strip at the
 * bottom of the screen when one of those checks fails; it is empty otherwise.
 * The strip sits on document.body, outside any region, so it shows on every
 * page (MMM-pages hides module regions, not this). */
Module.register("MMM-Guard", {
	getStyles () {
		return ["MMM-Guard.css"];
	},

	start () {
		this.sendSocketNotification("GUARD_HELLO");
	},

	socketNotificationReceived (notification, warnings) {
		if (notification !== "GUARD_HEALTH") return;
		let strip = document.getElementById("mg-warning");
		if (!Array.isArray(warnings) || warnings.length === 0) {
			if (strip) strip.remove();
			return;
		}
		if (!strip) {
			strip = document.createElement("div");
			strip.id = "mg-warning";
			strip.setAttribute("role", "alert");
			document.body.appendChild(strip);
		}
		strip.textContent = warnings.map((w) => w.text).join("   ·   ");
	}
});
