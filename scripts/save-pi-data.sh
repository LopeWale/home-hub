#!/usr/bin/env bash
# Copies the fridge's keys and saved data off the Pi's SD card onto a Mac,
# READ ONLY (debugfs without -w), for example before re-imaging the card.
# Needs Homebrew e2fsprogs (brew install e2fsprogs). Find the card's disk with
# `diskutil list`; the Linux partition is <disk>s2.
#   sudo bash scripts/save-pi-data.sh disk4 [pi-username]
set -uo pipefail
PART="/dev/${1:?whole card, e.g. disk4}s2"
PI_USER="${2:-pi}"
S=/opt/homebrew/opt/e2fsprogs/sbin
U="${SUDO_USER:-$USER}"
HOME_U="$(eval echo ~"$U")"
OUT="$HOME_U/pi-saved-data"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
mkdir -p "$OUT"
H="/home/$PI_USER"
MM=$H/MagicMirror
for f in \
	$MM/config/config.env \
	$MM/config/config.bridge.json \
	$H/.config/mm-configbridge/bridge.env \
	$H/.config/magicmirror/mm.env \
	$MM/modules/MMM-TodoList/tasks.json \
	$MM/modules/MMM-TodoList/members.json \
	$MM/modules/MMM-GlobeWeatherBridge/data/state.json \
	$MM/modules/MMM-BluetoothAudio/data/bluetooth.json; do
	dest="$OUT${f#$H}"
	mkdir -p "$(dirname "$dest")"
	"$S/debugfs" -R "dump $f $dest" "$PART" 2>/dev/null
	[ -s "$dest" ] || rm -f "$dest"
done
# bridge and installer backups (small)
mkdir -p "$OUT/.local/state"
"$S/debugfs" -R "rdump $H/.local/state/mm-fridge $OUT/.local/state" "$PART" 2>/dev/null
chown -R "$U" "$OUT"
chmod -R go-rwx "$OUT"

echo "Saved to $OUT:"
cd "$OUT" && find . -type f ! -path './.local/*' | sort | while read -r f; do
	case "$f" in
	*.env) printf '  %-55s %s settings: %s\n' "$f" "$(grep -c -E '^[A-Za-z_]+=.+' "$f")" "$(grep -o -E '^[A-Za-z_]+=' "$f" | tr -d '=' | tr '\n' ' ')" ;;
	*) printf '  %-55s %s bytes\n' "$f" "$(wc -c < "$f" | tr -d ' ')" ;;
	esac
done
echo "  plus backups: $(find .local -type f 2>/dev/null | wc -l | tr -d ' ') files in .local/state"
