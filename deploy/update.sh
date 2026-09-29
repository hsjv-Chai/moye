#!/usr/bin/env bash
set -euo pipefail
cd /opt/moye/deploy
# Run before any schema migration. Keep this separately from rotating daily dumps.
umask 077
mkdir -p /opt/moye/migration-backups
docker compose exec -T db pg_dump -U moye -d moye -Fc > "/opt/moye/migration-backups/pre-update-$(date -u +%Y%m%dT%H%M%SZ).dump"
old=$(docker compose images -q app)
docker tag "$old" moye-app:previous
docker compose build app
docker compose up -d --no-deps app
for n in $(seq 1 30); do
  if docker compose exec -T app node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
    docker compose exec -T nginx nginx -s reload
    exit 0
  fi
  sleep 2
done
APP_VERSION=previous docker compose up -d --no-deps app
docker compose exec -T nginx nginx -s reload
echo 'Update failed; previous application image restored. Inspect migration compatibility before retrying.' >&2
exit 1
