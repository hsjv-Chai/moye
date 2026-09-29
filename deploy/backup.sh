#!/usr/bin/env bash
set -euo pipefail
cd /opt/moye/deploy
umask 077
mkdir -p /opt/moye/backups
file="/opt/moye/backups/moye-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db pg_dump -U moye -d moye -Fc > "$file.tmp"
# Validate archive before rotating any previous backup.
docker compose exec -T db pg_restore --list < "$file.tmp" >/dev/null
mv "$file.tmp" "$file"
python3 - <<'PY'
from pathlib import Path
for p in sorted(Path('/opt/moye/backups').glob('moye-*.dump'), reverse=True)[7:]: p.unlink()
PY
