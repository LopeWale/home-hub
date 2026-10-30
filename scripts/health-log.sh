#!/usr/bin/env bash
# Records, once a minute, the numbers that would show a slow build-up on the
# Pi (memory, GPU buffer memory, open files, restarts of the mirror's GPU
# process) and how much has been written to the SD card in its life
# (card_write_mb, the kernel's ext4 lifetime_write_kbytes; it decides whether
# a read-only system is worth it, README "Failing SD card").
# Read-only: it changes nothing. Contains no keys or passwords.
#
# install.sh runs it at every boot as the user service mm-health.service
# (system/mm-health.service). Show one row per hour:
#   bash ~/.local/share/magicmirror/health-log.sh --summary
# Stop it:  systemctl --user disable --now mm-health
set -u

LOG="${HEALTH_LOG:-$HOME/fridge-health.log}"
EVERY="${HEALTH_EVERY:-60}"
MAX_BYTES="${HEALTH_MAX_BYTES:-10000000}" # about 2 months of lines; then the oldest half goes

if [ "${1:-}" = "--summary" ]; then
	[ -f "$LOG" ] || { echo "no log yet at $LOG"; exit 1; }
	# header, first sample, one sample per hour, last sample
	awk -F, 'NR == 1 || NR == 2 { print; next } $2 % 60 == 0 { print } { last = $0 } END { print last }' "$LOG" | column -s, -t
	awk -F, 'NR > 1 && $19 != "" { if (t1 == "") { t1 = $1; w1 = $19 } t2 = $1; w2 = $19 }
		END { if (t1 != "") printf "\nWritten to the SD card: %d MB from %s to %s\n", w2 - w1, t1, t2 }' "$LOG"
	exit 0
fi

meminfo_mb() { awk -v k="$1:" '$1 == k { printf "%d", $2 / 1024 }' /proc/meminfo; }

# Summed resident memory (MB) and process count of processes whose command line matches.
rss_of() { ps -eo rss=,args= | awk -v pat="$1" '$0 ~ pat && !/awk/ { s += $1; n++ } END { printf "%d,%d", s / 1024, n }'; }

pid_of() { pgrep -o -f "$1" 2>/dev/null || echo ""; }
fds_of() { [ -n "$1" ] && ls "/proc/$1/fd" 2>/dev/null | wc -l | tr -d ' ' || echo ""; }

# ext4 counters of the file system on / (for example /sys/fs/ext4/mmcblk0p2)
ROOT_FS="/sys/fs/ext4/$(basename "$(findmnt -no SOURCE / 2>/dev/null)")"
if [ ! -r "$ROOT_FS/lifetime_write_kbytes" ]; then
	# / shown as /dev/root or similar: use the only ext4 file system, if there is one
	set -- /sys/fs/ext4/*/lifetime_write_kbytes
	[ "$#" -eq 1 ] && [ -r "$1" ] && ROOT_FS="$(dirname "$1")"
fi
card_write_mb() { awk '{ printf "%d", $1 / 1024 }' "$ROOT_FS/lifetime_write_kbytes" 2>/dev/null; }

HEADER="time,uptime_min,mem_avail_mb,cma_free_mb,cma_total_mb,swap_used_mb,temp_c,throttled,mm_main_mb,renderer_mb,renderers,gpu_mb,gpu_pid,gpu_fds,labwc_mb,labwc_fds,input_devices,load1,card_write_mb"
if [ "$(head -n 1 "$LOG" 2>/dev/null)" != "$HEADER" ]; then
	# new log, or one with older columns: keep that one as .old
	[ -s "$LOG" ] && mv "$LOG" "$LOG.old"
	echo "$HEADER" > "$LOG"
fi

while :; do
	now="$(date +%Y-%m-%dT%H:%M:%S)"
	up_min="$(awk '{ printf "%d", $1 / 60 }' /proc/uptime)"
	swap_used=$(( $(meminfo_mb SwapTotal) - $(meminfo_mb SwapFree) ))
	temp="$(vcgencmd measure_temp 2>/dev/null | sed -E "s/[^0-9.]//g")"
	thr="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
	main="$(rss_of 'electron js/electron.js' | cut -d, -f1)"
	renderer="$(rss_of 'electron.*--type=renderer')"
	gpu="$(rss_of 'electron.*--type=gpu-process' | cut -d, -f1)"
	gpu_pid="$(pid_of 'electron.*--type=gpu-process')"
	labwc="$(rss_of '^/usr/bin/labwc' | cut -d, -f1)"
	labwc_pid="$(pid_of '^/usr/bin/labwc')"
	inputs="$(grep -c '^I:' /proc/bus/input/devices 2>/dev/null)"
	load1="$(cut -d' ' -f1 /proc/loadavg)"
	echo "$now,$up_min,$(meminfo_mb MemAvailable),$(meminfo_mb CmaFree),$(meminfo_mb CmaTotal),$swap_used,${temp:-},${thr:-},$main,$renderer,$gpu,$gpu_pid,$(fds_of "$gpu_pid"),$labwc,$(fds_of "$labwc_pid"),$inputs,$load1,$(card_write_mb)" >> "$LOG"
	if [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_BYTES" ]; then
		# keep the header and the newer half
		{ head -n 1 "$LOG"; tail -n +2 "$LOG" | tail -n "$(( $(wc -l < "$LOG") / 2 ))"; } > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
	fi
	sleep "$EVERY"
done
