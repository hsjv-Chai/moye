#!/usr/bin/env bash
set -euo pipefail
cd /opt/moye/deploy
docker compose run --rm certbot renew --cert-name 114.215.182.66 --non-interactive
docker compose exec -T nginx nginx -t
docker compose exec -T nginx nginx -s reload
