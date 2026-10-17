#!/usr/bin/env bash
# Starts MagicMirror (Electron) inside the logged in desktop session: labwc
# (Wayland, the default) or X11 if MM_DISPLAY_MODE=x11 is set in mm.env.
# Called by system/magicmirror.service (systemd user unit).
set -euo pipefail

MM_DIR="${MM_DIR:-$HOME/MagicMirror}"
MM_DISPLAY_MODE="${MM_DISPLAY_MODE:-auto}" # auto | wayland | x11
cd "$MM_DIR"

# Planet3D / globe needs WebGL on the GPU. MagicMirror disables the GPU
# unless this is 1 (js/electron.js). Set MM_DISABLE_GPU=1 to fall back.
if [ "${MM_DISABLE_GPU:-0}" != "1" ]; then
	export ELECTRON_ENABLE_GPU=1
fi

# A Pi 4 has no battery clock: after a power cut it boots with the last saved
# time (up to days old) and corrects it only once the network is up. Modules
# that ask for "today" (scores, weather) at start must not start before that.
# Wait up to 90 s for the clock (systemd-timesyncd), then start anyway, so an
# offline Pi still shows the screen.
for _ in $(seq 1 90); do
	[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ] && break
	sleep 1
done

if [ "$MM_DISPLAY_MODE" = "auto" ]; then
	# The session hook (labwc autostart or ~/.config/autostart) hands over
	# WAYLAND_DISPLAY or DISPLAY before it starts this service.
	MM_DISPLAY_MODE=x11
	[ -n "${WAYLAND_DISPLAY:-}" ] && MM_DISPLAY_MODE=wayland
fi

if [ "$MM_DISPLAY_MODE" = "wayland" ]; then
	# Wait up to 60 s for the compositor socket (boot race with labwc).
	for _ in $(seq 1 60); do
		if [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/${WAYLAND_DISPLAY}" ]; then
			break
		fi
		sleep 1
	done
	if [ -z "${WAYLAND_DISPLAY:-}" ]; then
		echo "mm-start: WAYLAND_DISPLAY is not set. Is labwc running and did autostart import the environment?" >&2
		exit 1
	fi
	exec ./node_modules/.bin/electron js/electron.js --ozone-platform=wayland
else
	export DISPLAY="${DISPLAY:-:0}"
	exec ./node_modules/.bin/electron js/electron.js --ozone-platform=x11
fi
