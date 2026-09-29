#!/usr/bin/env bash
set -euo pipefail
# Explicit operator action: replaces the database from a verified backup.
if [[ $# != 2 || "$1" != '--replace-database' ]]; then
  echo 'Usage: sudo bash restore-database.sh --replace-database /absolute/path/to/backup.dump' >&2
  exit 2
fi
backup="$2"
[[ "$backup" = /* && -f "$backup" ]] || exit 2
cd /opt/moye/deploy
docker compose exec -T db pg_restore --list < "$backup" >/dev/null
bash backup.sh
previous_epoch=$(docker compose exec -T db psql -U moye -d moye -Atc "SELECT COALESCE(MAX(epoch),0) FROM books")
[[ "$previous_epoch" =~ ^[0-9]+$ ]] || exit 1
docker compose stop app
docker compose exec -T db pg_restore -U moye -d moye --clean --if-exists --single-transaction < "$backup"
# Invalidate all existing clients after rolling back database history.
docker compose exec -T db psql -U moye -d moye -v ON_ERROR_STOP=1 -c "DELETE FROM sessions; UPDATE books SET epoch=GREATEST(epoch,$previous_epoch)+1, revision=revision+1;"
docker compose up -d app
docker compose exec -T nginx nginx -s reload
