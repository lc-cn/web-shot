#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
umask 077
backup_dir=/opt/webshot/backups
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
was_active=false
if systemctl is-active --quiet webshot; then was_active=true; fi
restore_service() { if "$was_active"; then systemctl start webshot; fi; }
trap restore_service EXIT
systemctl stop webshot
backup_file="$backup_dir/state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
# This private archive includes the local signing secret. Never upload it to GitHub.
tar -czf "$backup_file" -C / var/lib/webshot etc/webshot.env etc/webshot-egress.json
printf 'Private state backup: %s\n' "$backup_file"
