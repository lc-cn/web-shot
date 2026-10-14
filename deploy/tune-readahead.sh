#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
device=${1:-}
if [[ ! "$device" =~ ^[a-zA-Z0-9_-]+$ ]]; then echo 'Pass the root disk name, e.g. sda.' >&2; exit 1; fi
root_source=$(findmnt -n -o SOURCE /)
root_parent=$(lsblk -n -d -o PKNAME "$root_source")
if [[ "$root_parent" != "$device" && "$root_source" != "/dev/$device" ]]; then
  echo 'Device is not the root filesystem disk; no changes made.' >&2; exit 1
fi
setting="/sys/block/$device/queue/read_ahead_kb"
if [[ ! -w "$setting" ]]; then echo 'No writable disk read-ahead setting.' >&2; exit 1; fi
unit=/etc/systemd/system/webshot-readahead.service
if [[ -e "$unit" ]]; then echo "Existing $unit: inspect it before replacing; no changes made." >&2; exit 1; fi
cat > "$unit" <<UNIT
[Unit]
Description=Bounded filesystem read-ahead for the small Webshot VM
After=local-fs.target systemd-sysctl.service
Before=webshot.service
ConditionPathExists=$setting
[Service]
Type=oneshot
RemainAfterExit=yes
RuntimeDirectory=webshot-readahead
RuntimeDirectoryMode=0700
ExecStart=/bin/sh -ec 'cat $setting > /run/webshot-readahead/original; printf 128 > $setting'
ExecStop=/bin/sh -ec 'cat /run/webshot-readahead/original > $setting'
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now webshot-readahead.service
echo 'Disk read-ahead set to 128KiB. Restart Webshot to reopen Chrome mappings with the new setting.'
echo 'Rollback: systemctl disable --now webshot-readahead.service (restores the captured previous value).'
