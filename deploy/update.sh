#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then echo 'Run with sudo.' >&2; exit 1; fi
repo_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
if [[ -n $(git -c safe.directory="$repo_dir" -C "$repo_dir" status --porcelain) ]]; then
  echo 'Use a clean, committed checkout; local configuration belongs in ignored files.' >&2; exit 1
fi
export PATH="/opt/webshot/node/bin:${PATH}"
# Validate this checkout before copying code or restarting the running service.
npm ci --ignore-scripts --no-audit --no-fund --prefix "$repo_dir"
(cd "$repo_dir" && npm test)
backup_dir="/opt/webshot/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
tar --exclude=node_modules --exclude=data --exclude='.wrangler' -cf "$backup_dir/app.tar" -C /opt/webshot/app .
# git archive includes only committed source, never local credentials or runtime data.
git -c safe.directory="$repo_dir" -C "$repo_dir" archive HEAD | tar -xf - -C /opt/webshot/app
npm ci --ignore-scripts --no-audit --no-fund --prefix /opt/webshot/app
systemctl restart webshot
printf 'Code updated. Previous source: %s/app.tar\n' "$backup_dir"
for attempt in $(seq 1 40); do
  if curl -fsS --max-time 2 http://127.0.0.1:3030/healthz >/dev/null; then
    echo 'Chrome and prewarmed pages are ready.'; exit 0
  fi
  sleep 1
done
echo 'Readiness check failed; inspect journalctl -u webshot. Restore app.tar using docs/operations.md.' >&2
exit 1
