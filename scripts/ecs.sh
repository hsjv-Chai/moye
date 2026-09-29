#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$project_dir/.runtime"
exec ssh-agent bash -c '
  key="$1"; known="$2"; shift 2
  ssh-add - < "$key" >/dev/null 2>&1
  extra=()
  if [[ -n "${MOYE_SSH_PROXY:-}" ]]; then
    [[ "$MOYE_SSH_PROXY" =~ ^[a-zA-Z0-9._-]+:[0-9]+$ ]] || exit 2
    extra=(-o "ProxyCommand=nc -X connect -x $MOYE_SSH_PROXY %h %p")
  fi
  exec ssh "${extra[@]}" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known" -p 22 ecs-user@114.215.182.66 "$@"
' _ "${MOYE_SSH_KEY:-/Users/hsjv/Downloads/key1.pem}" "$project_dir/.runtime/known_hosts" "$@"
