#!/usr/bin/env bash
# Post install checks on the Pi. Read only. Prints PASS / WARN / FAIL lines.
#   scripts/verify.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MM_DIR="${MM_DIR:-$HOME/MagicMirror}"
MM_URL="${MM_URL:-http://localhost:8080}"
fails=0
pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARN\033[0m %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; fails=$((fails + 1)); }

# --- runtime
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>=24||(a===22&&(b>22||(b===22&&c>=2)))?0:1)' \
	&& pass "node $(node -v)" || fail "node $(node -v 2>/dev/null) is older than 22.22.2"
[ "$(git -C "$MM_DIR" rev-parse HEAD 2>/dev/null)" = "f138f5b690ceab6450f55c852ac81d268363f563" ] \
	&& pass "MagicMirror v2.38.0" || warn "MagicMirror is not at the pinned v2.38.0 commit"

for unit in mm-configbridge magicmirror; do
	systemctl --user is-active --quiet "$unit" && pass "service $unit active" || fail "service $unit not active (journalctl --user -u $unit)"
done

# --- modules at pinned commits, patches applied
while read -r -u 3 name url commit npm_mode; do
	case "$name" in ''|'#'*) continue ;; esac
	dir="$MM_DIR/modules/$name"
	have="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo missing)"
	if [ "$have" != "$commit" ]; then fail "$name at $have, want $commit"; continue; fi
	if [ -f "$REPO_DIR/patches/$name.patch" ]; then
		git -C "$dir" apply --reverse --check "$REPO_DIR/patches/$name.patch" 2>/dev/null && pass "$name pinned + patched" || fail "$name patch not applied"
	else
		pass "$name pinned"
	fi
done 3< "$REPO_DIR/modules.lock"
[ -f "$MM_DIR/modules/MMM-GlobeWeatherBridge/vendor/globe.gl.min.js" ] && pass "globe.gl vendored" || fail "globe assets missing (scripts/fetch-globe-assets.sh)"

# --- MagicMirror HTTP and secret hygiene
if curl -fsS -o /dev/null "$MM_URL/"; then
	pass "MagicMirror answers on $MM_URL"
	cfg="$(curl -fsS "$MM_URL/config/")"
	for m in MMM-pages MMM-MyGCalendar MMM-TodoList MMM-SplitLayout MMM-GlobeWeatherBridge MMM-GuestNet; do
		grep -q "\"$m\"" <<<"$cfg" && pass "config contains $m" || fail "config missing $m"
	done
	code="$(curl -s -o /dev/null -w '%{http_code}' "$MM_URL/config/config.env")"
	[ "$code" = "404" ] && pass "config.env not served (HTTP 404)" || fail "config.env served with HTTP $code"
	# No SECRET_ value from config.env may appear in what the browser receives.
	leaked=0
	if [ -r "$MM_DIR/config/config.env" ]; then
		while IFS= read -r name; do
			value="$(node -e 'const v=require("util").parseEnv(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];process.stdout.write(v||"")' "$MM_DIR/config/config.env" "$name")"
			[ "${#value}" -ge 6 ] || continue
			if grep -qF -- "$value" <<<"$cfg"; then fail "secret $name is visible in the browser config"; leaked=1; fi
			if [ -f "$MM_DIR/config/config.bridge.json" ] && grep -qF -- "$value" "$MM_DIR/config/config.bridge.json"; then fail "secret $name is stored in config.bridge.json"; leaked=1; fi
		done < <(grep -oE '^[[:space:]]*SECRET_[A-Z0-9_]+' "$MM_DIR/config/config.env" | tr -d '[:space:]' | sort -u)
		[ "$leaked" -eq 0 ] && pass "no SECRET_ values in browser config or config.bridge.json"
	fi
else
	fail "MagicMirror not reachable on $MM_URL"
fi

# --- bridge bind address
if command -v ss >/dev/null 2>&1; then
	listen="$(ss -ltnH 'sport = :8081' 2>/dev/null | awk '{print $4}')"
	if [ -z "$listen" ]; then fail "bridge not listening on :8081 (is tailscale up?)"
	elif grep -qE '^(0\.0\.0\.0|\*|\[::\]):8081$' <<<"$listen"; then fail "bridge listens on all interfaces: $listen"
	elif grep -qE '^100\.' <<<"$listen"; then pass "bridge bound to Tailscale address $listen"
	else warn "bridge bound to $listen"
	fi
fi

# --- YouTube cast receiver (MMM-YouTubeCast)
[ -f "$MM_DIR/modules/MMM-YouTubeCast/node_modules/yt-cast-receiver/dist/index.js" ] && pass "yt-cast-receiver installed" || fail "yt-cast-receiver missing (./install.sh --update)"
if curl -fsS -m 5 "http://localhost:8569/ytcr/ssdp/device-desc.xml" 2>/dev/null | grep -q "<friendlyName>"; then
	pass "cast receiver answers discovery on :8569"
else
	fail "cast receiver not answering on :8569 (journalctl --user -u magicmirror | grep YouTubeCast)"
fi

# --- paper theme, guest Wi-Fi popup, network icon
[ -f "$MM_DIR/config/fonts/literata-latin-wght-normal.woff2" ] && pass "Literata font installed" || fail "config/fonts missing (./install.sh --update)"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$MM_URL/config/fonts/literata-latin-wght-normal.woff2")" = "200" ] && pass "Literata font served" || fail "Literata font not served by MagicMirror"
curl -sI "$MM_URL/" | grep -qi '^referrer-policy: strict-origin-when-cross-origin' && pass "referrer policy lets the browser key's website restriction work" || fail "referrer policy is not strict-origin-when-cross-origin (httpHeaders in config.js)"
[ -f "$MM_DIR/modules/MMM-GuestNet/node_modules/qrcode/package.json" ] && pass "qrcode installed (guest Wi-Fi popup)" || fail "MMM-GuestNet: qrcode missing (./install.sh --update)"
command -v nmcli >/dev/null && pass "nmcli present (network icon)" || warn "nmcli missing: the network icon cannot show Wi-Fi strength"
if bluetoothctl show 2>/dev/null | grep -q "Powered: yes"; then pass "Bluetooth on and reachable (speaker icon)"; else warn "Bluetooth off or not reachable by $USER (speaker icon): bluetoothctl show"; fi
command -v pw-dump >/dev/null && command -v wpctl >/dev/null && pass "PipeWire tools present (Bluetooth sound routing)" || fail "pw-dump or wpctl missing (sudo apt install pipewire-bin wireplumber)"
if [ -r "$MM_DIR/config/config.env" ] && grep -qE '^[[:space:]]*GOOGLE_MAPS_BROWSER_KEY=.+' "$MM_DIR/config/config.env"; then
	pass "GOOGLE_MAPS_BROWSER_KEY set (Google 3D Earth)"
else
	warn "GOOGLE_MAPS_BROWSER_KEY not set: the globe page shows the simple globe"
fi

# --- data
[ -w "$MM_DIR/modules/MMM-TodoList" ] && pass "todo data dir writable" || fail "MMM-TodoList folder not writable"
command -v python3 >/dev/null && pass "python3 present (MMM-TodoList)" || fail "python3 missing"
grep -q 'magicmirror kiosk' "$HOME/.config/labwc/autostart" 2>/dev/null && pass "labwc autostart hook present" || fail "labwc autostart hook missing"

echo
[ "$fails" -eq 0 ] && echo "All checks passed." || echo "$fails check(s) failed."
exit "$fails"
