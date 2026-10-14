#!/usr/bin/env bash
# Fridge planner installer for Raspberry Pi 4, Raspberry Pi OS 64-bit
# (Bookworm or Trixie, labwc Wayland desktop). Run on the Pi as the desktop
# user (not root), from the copied project folder:
#
#   ./install.sh            full install (apt, Node, MagicMirror, modules, services)
#   ./install.sh --update   redeploy modules, patches, config and services only
#
# Options:
#   --no-tailscale     do not install Tailscale (it is installed by default if missing)
#   --no-raspi-config  do not change boot to desktop autologin / screen blanking
#   --no-start         install everything but do not (re)start the services
#   --no-services      skip systemd, linger and labwc steps (container tests only)
#
# Safe to re-run. Existing config.env, config.bridge.json, bridge.env, todo
# data and globe pins are kept; replaced config files are backed up first.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# USB sticks and some copy tools drop the executable bit; put it back.
chmod +x "$REPO_DIR/install.sh" "$REPO_DIR"/scripts/*.sh "$REPO_DIR"/system/*.sh 2>/dev/null || true
MM_DIR="${MM_DIR:-$HOME/MagicMirror}"
MM_VERSION_TAG="v2.38.0"
# MagicMirror 2.38.0 ships Electron 44.4.5, which flashes the screen and then
# blanks it on Pi OS trixie (MagicMirrorOrg/MagicMirror#4287). 44.5.1 is the
# fix the maintainers chose for the next release. Remove this once
# MM_VERSION_TAG is a release that already uses it.
ELECTRON_VERSION="44.5.1"
MM_COMMIT="f138f5b690ceab6450f55c852ac81d268363f563"
NODE_MAJOR=24
STATE_DIR="$HOME/.local/state/mm-fridge"
BRIDGE_DIR="$HOME/.local/share/mm-configbridge"
BRIDGE_ENV="$HOME/.config/mm-configbridge/bridge.env"
UNIT_DIR="$HOME/.config/systemd/user"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$STATE_DIR/backups/$STAMP"

UPDATE_ONLY=0
WITH_TAILSCALE=1
RASPI_CONFIG=1
START=1
SERVICES=1
for arg in "$@"; do
	case "$arg" in
		--update) UPDATE_ONLY=1 ;;
		--with-tailscale) WITH_TAILSCALE=1 ;; # default, kept for old instructions
		--no-tailscale) WITH_TAILSCALE=0 ;;
		--no-raspi-config) RASPI_CONFIG=0 ;;
		--no-start) START=0 ;;
		--no-services) SERVICES=0; START=0 ;;
		-h|--help) sed -n '2,17p' "$0"; exit 0 ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run as your normal desktop user, not root (sudo is used where needed)"
[ "$(uname -s)" = "Linux" ] || die "this installer is for the Raspberry Pi (Linux). Use scripts/deploy-to-pi.sh from a Mac."
[ "$(uname -m)" = "aarch64" ] || warn "expected aarch64 (64-bit Raspberry Pi OS), got $(uname -m)"
if [ -r /etc/os-release ]; then
	. /etc/os-release
	case "${VERSION_CODENAME:-}" in
		bookworm|trixie) ;;
		*) warn "tested targets are Raspberry Pi OS Bookworm and Trixie, found ${PRETTY_NAME:-unknown}" ;;
	esac
fi

node_ok() {
	command -v node >/dev/null 2>&1 || return 1
	node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>=24||(a===22&&(b>22||(b===22&&c>=2)))?0:1)'
}

# ---------------------------------------------------------------- system
if [ "$UPDATE_ONLY" -eq 0 ]; then
	say "Installing OS packages"
	sudo apt-get update
	sudo apt-get install -y git curl ca-certificates gnupg rsync python3 iputils-ping fonts-noto-color-emoji

	if ! node_ok; then
		say "Installing Node.js ${NODE_MAJOR}.x from NodeSource (MagicMirror 2.38 needs >= 22.22.2)"
		sudo install -d -m 0755 /etc/apt/keyrings
		curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
		echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
		sudo apt-get update
		sudo apt-get install -y nodejs
	fi
	node_ok || die "Node.js >= 22.22.2 is required, found $(node -v 2>/dev/null || echo none)"
	echo "node $(node -v), npm $(npm -v)"

	# Calendar days are computed in the Pi's local time zone.
	tz="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || true)"
	case "$tz" in
		""|UTC|Etc/UTC|Etc/GMT|GMT) warn "time zone is '${tz:-unknown}'. Set yours, e.g.: sudo raspi-config nonint do_change_timezone America/Chicago" ;;
		*) echo "time zone $tz" ;;
	esac

	if ! command -v tailscale >/dev/null 2>&1; then
		if [ "$WITH_TAILSCALE" -eq 1 ]; then
			say "Installing Tailscale (official script)"
			curl -fsSL https://tailscale.com/install.sh | sh
		else
			warn "tailscale not installed (--no-tailscale). The admin bridge waits until a Tailscale IP exists."
		fi
	fi
fi
node_ok || die "Node.js >= 22.22.2 is required"

# ---------------------------------------------------------------- MagicMirror
if [ ! -d "$MM_DIR/.git" ]; then
	[ "$UPDATE_ONLY" -eq 0 ] || die "$MM_DIR not found. Run a full install first."
	say "Cloning MagicMirror $MM_VERSION_TAG"
	git clone --depth 1 --branch "$MM_VERSION_TAG" https://github.com/MagicMirrorOrg/MagicMirror.git "$MM_DIR"
	[ "$(git -C "$MM_DIR" rev-parse HEAD)" = "$MM_COMMIT" ] || die "MagicMirror tag $MM_VERSION_TAG does not match the pinned commit"
	say "Installing MagicMirror dependencies (slow on a Pi, often 10+ minutes with little output)"
	(cd "$MM_DIR" && node --run install-mm)
else
	have="$(git -C "$MM_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
	[ "$have" = "$MM_COMMIT" ] || warn "MagicMirror at $MM_DIR is $have, this project was built against $MM_VERSION_TAG ($MM_COMMIT)"
	if [ ! -x "$MM_DIR/node_modules/.bin/electron" ]; then
		say "MagicMirror dependencies missing, installing"
		(cd "$MM_DIR" && node --run install-mm)
	fi
fi
have_electron="$(node -p "require('$MM_DIR/node_modules/electron/package.json').version" 2>/dev/null || echo none)"
if [ "$have_electron" != "$ELECTRON_VERSION" ]; then
	say "Electron $have_electron -> $ELECTRON_VERSION (MagicMirror issue #4287; downloads about 100 MB)"
	# the command from the issue; --no-save leaves MagicMirror's own files untouched
	(cd "$MM_DIR" && npm install --no-save --package-lock=false --no-audit --no-fund --loglevel=error "electron@$ELECTRON_VERSION") ||
		warn "could not install Electron $ELECTRON_VERSION; still on $have_electron"
fi

# ---------------------------------------------------------------- bluetooth speakers
# Runs with --update too. Raspberry Pi OS desktop normally has all of this already.
say "Checking Bluetooth audio"
bt_missing=""
for pkg in bluez libspa-0.2-bluetooth pipewire-bin wireplumber; do
	dpkg -s "$pkg" >/dev/null 2>&1 || bt_missing="$bt_missing $pkg"
done
if [ -n "$bt_missing" ]; then
	echo "    installing:$bt_missing"
	sudo apt-get install -y $bt_missing || warn "could not install$bt_missing (Bluetooth speakers will not work)"
fi
sudo systemctl enable --now bluetooth >/dev/null 2>&1 || warn "could not start the bluetooth service"
sudo rfkill unblock bluetooth 2>/dev/null || true
# The mirror runs as $USER and talks to BlueZ over D-Bus, which Debian allows for the bluetooth group.
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx bluetooth; then
	sudo usermod -aG bluetooth "$USER" && warn "added $USER to the bluetooth group: reboot once so the speaker icon can use Bluetooth"
fi

# ---------------------------------------------------------------- backups
say "Backing up current data to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
chmod 700 "$STATE_DIR" "$STATE_DIR/backups" 2>/dev/null || true
for f in \
	"$MM_DIR/modules/MMM-TodoList/tasks.json" \
	"$MM_DIR/modules/MMM-GlobeWeatherBridge/data/state.json" \
	"$MM_DIR/config/config.js" "$MM_DIR/config/custom.css" \
	"$MM_DIR/config/config.bridge.json" "$MM_DIR/config/config.env"; do
	[ -f "$f" ] && cp -p "$f" "$BACKUP_DIR/$(basename "$(dirname "$f")")__$(basename "$f")"
done
chmod -R go-rwx "$BACKUP_DIR"

# ---------------------------------------------------------------- third party modules
say "Installing pinned third party modules"
# fd 3 so git/npm inside the loop cannot swallow lines of modules.lock
while read -r -u 3 name url commit npm_mode; do
	case "$name" in ''|'#'*) continue ;; esac
	dir="$MM_DIR/modules/$name"
	echo "--- $name @ ${commit:0:7}"
	if [ -d "$dir/.git" ]; then
		current_url="$(git -C "$dir" remote get-url origin)"
		if [ "$current_url" != "$url" ]; then
			warn "$name: origin is $current_url, switching to $url"
			git -C "$dir" remote set-url origin "$url"
		fi
		git -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null || git -C "$dir" fetch --quiet origin
	elif [ -e "$dir" ]; then
		mv "$dir" "$BACKUP_DIR/module__$name"
		warn "$name: existing non git folder moved to $BACKUP_DIR"
		git clone --quiet "$url" "$dir"
	else
		git clone --quiet "$url" "$dir"
	fi
	# -f resets tracked files (including previous patches). Untracked data such
	# as MMM-TodoList/tasks.json and node_modules is left alone.
	git -C "$dir" -c advice.detachedHead=false checkout --quiet -f "$commit"
	patch="$REPO_DIR/patches/$name.patch"
	if [ -f "$patch" ]; then
		# Files the patch adds (e.g. MMM-TodoList/tabs.js) are untracked, so
		# checkout -f leaves the copy from the previous install in place and
		# git apply would refuse to create it again. Remove exactly those.
		git -C "$dir" apply --summary "$patch" | awk '$1 == "create" {print $NF}' | while read -r added; do
			case "$added" in ""|*/../*|../*|/*) continue ;; esac
			rm -f -- "${dir:?}/${added:?}"
		done
		git -C "$dir" apply --whitespace=nowarn "$patch" || die "$name: patch did not apply"
		echo "    patched ($(basename "$patch"))"
	fi
	case "$npm_mode" in
		none) ;;
		prod) (cd "$dir" && npm install --omit=dev --no-audit --no-fund --loglevel=error) ;;
		ci) (cd "$dir" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) ;;
		*) die "$name: unknown npm mode $npm_mode" ;;
	esac
done 3< "$REPO_DIR/modules.lock"


# ---------------------------------------------------------------- custom modules
say "Deploying custom modules"
for m in "$REPO_DIR"/modules/*/; do
	name="$(basename "$m")"
	mkdir -p "$MM_DIR/modules/$name"
	rsync -a --delete --exclude 'data/' --exclude 'vendor/' --exclude 'node_modules/' --exclude '._*' --exclude '.DS_Store' "$m" "$MM_DIR/modules/$name/"
	find "$MM_DIR/modules/$name" -path "$MM_DIR/modules/$name/node_modules" -prune -o \( -name '._*' -o -name '.DS_Store' \) -type f -exec rm -f {} +
	echo "--- $name"
	# Custom modules with dependencies (MMM-YouTubeCast) install exactly what their lockfile says.
	if [ -f "$MM_DIR/modules/$name/package-lock.json" ]; then
		(cd "$MM_DIR/modules/$name" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || die "$name: npm ci failed"
	fi
done
bash "$REPO_DIR/scripts/fetch-globe-assets.sh" "$MM_DIR/modules/MMM-GlobeWeatherBridge"

# ---------------------------------------------------------------- config
say "Installing config"
install_config() { # src dst mode
	local src="$1" dst="$2" mode="$3"
	if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then
		echo "    updating $(basename "$dst") (old copy in $BACKUP_DIR)"
	fi
	install -m "$mode" "$src" "$dst"
}
install_config "$REPO_DIR/config/config.js" "$MM_DIR/config/config.js" 644
install_config "$REPO_DIR/config/custom.css" "$MM_DIR/config/custom.css" 644
install_config "$REPO_DIR/config/mm-bridge-merge.js" "$MM_DIR/config/mm-bridge-merge.js" 644
# Literata, the e-book typeface used by custom.css (SIL Open Font License).
mkdir -p "$MM_DIR/config/fonts"
install -m 644 "$REPO_DIR"/config/fonts/* "$MM_DIR/config/fonts/"
if [ ! -f "$MM_DIR/config/config.env" ]; then
	install -m 600 "$REPO_DIR/config/config.env.example" "$MM_DIR/config/config.env"
	warn "created $MM_DIR/config/config.env from the example. Fill in your keys, feeds and home location."
else
	chmod 600 "$MM_DIR/config/config.env"
	grep -q '^SECRET_MM_FULL_PASS=1' "$MM_DIR/config/config.env" || {
		printf '\n# Required by config.js (bridge secrets resolve on the server only)\nSECRET_MM_FULL_PASS=1\n' >> "$MM_DIR/config/config.env"
		echo "    added SECRET_MM_FULL_PASS=1 to config.env"
	}
fi
[ -f "$MM_DIR/config/config.bridge.json" ] || install -m 644 "$REPO_DIR/config/config.bridge.json.example" "$MM_DIR/config/config.bridge.json"
# Guest Wi-Fi moved from MMM-WiFiPassword (own page) to MMM-GuestNet (popup): carry admin page values over.
node "$REPO_DIR/scripts/migrate-bridge.js" "$MM_DIR/config/config.bridge.json"

# ---------------------------------------------------------------- config bridge
say "Deploying config bridge to $BRIDGE_DIR"
mkdir -p "$BRIDGE_DIR"
rsync -a --delete --exclude 'bridge.env' --exclude '*.example' --exclude '._*' --exclude '.DS_Store' "$REPO_DIR/config-bridge/" "$BRIDGE_DIR/"
find "$BRIDGE_DIR" \( -name '._*' -o -name '.DS_Store' \) -type f -exec rm -f {} +
install -m 644 "$REPO_DIR/config/mm-bridge-merge.js" "$BRIDGE_DIR/lib/mm-bridge-merge.js"
mkdir -p "$(dirname "$BRIDGE_ENV")"
chmod 700 "$(dirname "$BRIDGE_ENV")"
if [ ! -f "$BRIDGE_ENV" ]; then
	token="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
	sed -e "s|^BRIDGE_TOKEN=.*|BRIDGE_TOKEN=$token|" -e "s|^MM_DIR=.*|MM_DIR=$MM_DIR|" "$REPO_DIR/config-bridge/bridge.env.example" > "$BRIDGE_ENV"
	chmod 600 "$BRIDGE_ENV"
	echo "    generated a new bridge token in $BRIDGE_ENV"
fi

# ---------------------------------------------------------------- services
if [ "$SERVICES" -eq 1 ]; then
say "Installing systemd user services"
mkdir -p "$UNIT_DIR" "$HOME/.local/share/magicmirror" "$HOME/.config/magicmirror"
install -m 755 "$REPO_DIR/system/mm-start.sh" "$HOME/.local/share/magicmirror/mm-start.sh"
install -m 644 "$REPO_DIR/system/magicmirror.service" "$UNIT_DIR/magicmirror.service"
install -m 644 "$REPO_DIR/system/mm-configbridge.service" "$UNIT_DIR/mm-configbridge.service"
[ -f "$HOME/.config/magicmirror/mm.env" ] || printf '# Extra environment for MagicMirror, e.g.\n# MM_DISABLE_GPU=1\n# MM_DISPLAY_MODE=x11\n' > "$HOME/.config/magicmirror/mm.env"
systemctl --user daemon-reload
systemctl --user enable mm-configbridge.service
# Let user services start at boot without an interactive login.
loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes' || sudo loginctl enable-linger "$USER"

say "Hooking MagicMirror into the labwc session autostart"
AUTOSTART="$HOME/.config/labwc/autostart"
mkdir -p "$(dirname "$AUTOSTART")"
touch "$AUTOSTART"
if grep -q '>>> magicmirror kiosk >>>' "$AUTOSTART"; then
	sed -i '/>>> magicmirror kiosk >>>/,/<<< magicmirror kiosk <<</d' "$AUTOSTART"
fi
cat "$REPO_DIR/system/labwc-autostart.snippet" >> "$AUTOSTART"

fi # SERVICES

if [ "$RASPI_CONFIG" -eq 1 ] && command -v raspi-config >/dev/null 2>&1 && [ "$UPDATE_ONLY" -eq 0 ]; then
	say "raspi-config: desktop autologin, screen blanking off"
	sudo raspi-config nonint do_boot_behaviour B4 || warn "could not set desktop autologin"
	sudo raspi-config nonint do_blanking 1 || warn "could not disable screen blanking"
fi

# Let this user run `tailscale ip` / `tailscale whois` without sudo (the bridge
# uses whois for BRIDGE_ALLOWED_TAILSCALE_USERS).
if command -v tailscale >/dev/null 2>&1; then
	sudo tailscale set --operator="$USER" 2>/dev/null || warn "could not run 'tailscale set --operator=$USER' (run it after 'sudo tailscale up')"
fi

# ---------------------------------------------------------------- check and start
say "MagicMirror config check"
(cd "$MM_DIR" && node --run config:check) || warn "config check reported problems (see above)"

if [ "$START" -eq 1 ]; then
	say "Starting services"
	systemctl --user restart mm-configbridge.service
	if [ -n "${WAYLAND_DISPLAY:-}" ]; then
		systemctl --user import-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE XDG_CURRENT_DESKTOP DISPLAY
		systemctl --user restart magicmirror.service
	elif systemctl --user show-environment 2>/dev/null | grep -q -E '^(WAYLAND_DISPLAY|DISPLAY)='; then
		# Over SSH: the desktop session (labwc or X11) already handed its display to the user manager.
		systemctl --user restart magicmirror.service
	else
		echo "    no desktop session yet. MagicMirror starts at the next desktop login, or reboot now."
	fi
fi

ts_ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
if command -v tailscale >/dev/null 2>&1 && [ -z "$ts_ip" ]; then
	warn "Tailscale is installed but not logged in. Run: sudo tailscale up   (then open the printed link to sign in)"
fi
cat <<EOF

Done.
  MagicMirror      : $MM_DIR (logs: journalctl --user -u magicmirror -f)
  Secrets          : $MM_DIR/config/config.env (edit, then: systemctl --user restart magicmirror)
  Admin bridge     : http://${ts_ip:-<pi-tailscale-ip>}:8081/admin   (Tailscale only)
  Admin token      : $BRIDGE_ENV  (BRIDGE_TOKEN=...)
  Backups          : $BACKUP_DIR
  Verify           : $REPO_DIR/scripts/verify.sh
EOF
