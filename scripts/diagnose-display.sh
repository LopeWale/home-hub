#!/usr/bin/env bash
# Read-only checks for a flickering or blanking screen. Changes nothing.
#   bash ~/MagicMirrorCode/scripts/diagnose-display.sh
# Paste the whole output back. It contains no keys or passwords.
set -u

section() { printf '\n===== %s =====\n' "$*"; }

section "Power (0x0 is good; any other value means low voltage or throttling)"
if command -v vcgencmd >/dev/null; then
	vcgencmd get_throttled
	vcgencmd measure_temp
	vcgencmd measure_volts core 2>/dev/null
else
	echo "vcgencmd not found"
fi

section "Kernel messages: power, display, GPU (last 30)"
sudo dmesg 2>/dev/null | grep -i -E "voltage|throttl|vc4|drm|hdmi|v3d|gpu|oom|out of memory" | tail -30

section "Memory and load"
free -h
uptime
swapon --show 2>/dev/null

section "Hardware"
tr -d '\0' < /proc/device-tree/model 2>/dev/null; echo
grep -E "^(dtoverlay|gpu_mem|hdmi|max_framebuffers|disable_fw_kms|arm_boost)" /boot/firmware/config.txt 2>/dev/null

section "MagicMirror service: restarts and uptime"
systemctl --user show magicmirror -p NRestarts -p ActiveEnterTimestamp -p MainPID 2>/dev/null
cat ~/.config/magicmirror/mm.env 2>/dev/null | grep -v -i -E "key|token|pass|secret" || echo "(no mm.env)"

section "Electron GPU and renderer problems since boot (last 30)"
sudo journalctl -b _UID="$(id -u)" --no-pager 2>/dev/null | grep -i -E "gpu process|gpu_process|GPU state|crash|exited|viz|Lost connection|EGL|gbm|wayland.*error|out of memory|Aw, Snap|renderer" | tail -30

section "Busiest processes"
ps -eo pid,pcpu,pmem,rss,args --sort=-pcpu | head -8 | cut -c1-140

section "Display session"
echo "session: ${XDG_SESSION_TYPE:-?} desktop: ${XDG_CURRENT_DESKTOP:-?}"
ps -eo args | grep -E "^/usr/bin/(labwc|wayfire)|lightdm" | grep -v grep | head -3
