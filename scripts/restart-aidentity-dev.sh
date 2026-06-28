#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/srv/codex-shared/unknown"
APPS=(
  dev-aidentity-api
  dev-aidentity-web
)

log() {
  printf '== %s ==\n' "$1"
}

cd "$APP_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

log "Restarting Aidentity dev PM2 apps"
output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

for app in "${APPS[@]}"; do
  if ! pm2 startOrRestart ecosystem.config.cjs --only "$app" --update-env --silent >"$output_file" 2>&1; then
    cat "$output_file" >&2
    exit 1
  fi
done

pm2 save --silent

pm2 list
