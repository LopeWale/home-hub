#!/usr/bin/env bash
# Puts the keys and saved data from ~/pi-saved-data (made by save-pi-data.sh)
# back onto a freshly installed Pi, then restarts the mirror and the admin page.
# Run AFTER the full install (deploy-to-pi.sh without --update).
#   bash scripts/restore-pi-data.sh pi@homehub.local
set -euo pipefail
TARGET="${1:?usage: restore-pi-data.sh user@host}"
SRC="$HOME/pi-saved-data"
[ -f "$SRC/MagicMirror/config/config.env" ] || { echo "no saved data in $SRC"; exit 1; }
# --no-xattrs / COPYFILE_DISABLE: no macOS "._" files on the Pi
COPYFILE_DISABLE=1 tar --no-xattrs -C "$SRC" -cf - .config MagicMirror |
	ssh "$TARGET" 'tar -C ~ -xpf - &&
		chmod 600 ~/MagicMirror/config/config.env ~/.config/mm-configbridge/bridge.env &&
		systemctl --user restart mm-configbridge.service magicmirror.service &&
		echo "restored and restarted"'
