#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
if [[ ! -w /sys/module/zswap/parameters/enabled ]]; then
  echo 'This kernel has no writable zswap interface; no changes made.' >&2; exit 1
fi
unit=/etc/systemd/system/webshot-zswap.service
if [[ -e "$unit" ]]; then
  echo "Existing $unit: inspect it before replacing; no changes made." >&2; exit 1
fi
cat > "$unit" <<'UNIT'
[Unit]
Description=Bounded compressed swap for the small Webshot VM
After=systemd-sysctl.service
Before=webshot.service
ConditionPathExists=/sys/module/zswap/parameters/enabled
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -ec 'printf 10 > /sys/module/zswap/parameters/max_pool_percent; printf 1 > /sys/module/zswap/parameters/enabled'
ExecStop=/bin/sh -ec 'printf 0 > /sys/module/zswap/parameters/enabled'
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now webshot-zswap.service
echo 'zswap enabled with a 10% RAM pool ceiling; existing swap and swappiness preserved.'
