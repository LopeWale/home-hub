#!/usr/bin/env bash
# Records, once a minute, the numbers that would show a slow build-up on the
# Pi (memory, GPU buffer memory, open files, restarts of the mirror's GPU
# process). Read-only: it changes nothing. Contains no keys or passwords.
#
# Start it within a few minutes of a reboot and leave it running:
#   nohup bash ~/MagicMirrorCode/scripts/health-log.sh >/dev/null 2>&1 &
# When the glitching has become frequent, show one row per hour:
#   bash ~/MagicMirrorCode/scripts/health-log.sh --summary
# Stop it:  pkill -f health-log.sh
set -u

LOG="${HEALTH_LOG:-$HOME/fridge-health.log}"
EVERY="${HEALTH_EVERY:-60}"

if [ "${1:-}" = "--summary" ]; then
	[ -f "$LOG" ] || { echo "no log yet at $LOG"; exit 1; }
	# header, first sample, one sample per hour, last sample
	awk -F, 'NR == 1 || NR == 2 { print; next } $2 % 60 == 0 { print } { last = $0 } END { print last }' "$LOG" | column -s, -t
	exit 0
fi

meminfo_mb() { awk -v k="$1:" '$1 == k { printf "%d", $2 / 1024 }' /proc/meminfo; }

# Summed resident memory (MB) and process count of processes whose command line matches.
rss_of() { ps -eo rss=,args= | awk -v pat="$1" '$0 ~ pat && !/awk/ { s += $1; n++ } END { printf "%d,%d", s / 1024, n }'; }

pid_of() { pgrep -o -f "$1" 2>/dev/null || echo ""; }
fds_of() { [ -n "$1" ] && ls "/proc/$1/fd" 2>/dev/null | wc -l | tr -d ' ' || echo ""; }

if [ ! -s "$LOG" ]; then
	echo "time,uptime_min,mem_avail_mb,cma_free_mb,cma_total_mb,swap_used_mb,temp_c,throttled,mm_main_mb,renderer_mb,renderers,gpu_mb,gpu_pid,gpu_fds,labwc_mb,labwc_fds,input_devices,load1" > "$LOG"
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
	echo "$now,$up_min,$(meminfo_mb MemAvailable),$(meminfo_mb CmaFree),$(meminfo_mb CmaTotal),$swap_used,${temp:-},${thr:-},$main,$renderer,$gpu,$gpu_pid,$(fds_of "$gpu_pid"),$labwc,$(fds_of "$labwc_pid"),$inputs,$load1" >> "$LOG"
	sleep "$EVERY"
done
