#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '🚀 [deploy-aidentity-web] %s\n' "$*"
}

section() {
  printf '\n✨ [deploy-aidentity-web] == %s ==\n' "$*"
}

run_quiet() {
  local output_file
  output_file="$(mktemp)"

  if "$@" >"$output_file" 2>&1; then
    rm -f "$output_file"
    return
  fi

  local status=$?
  log "❌ Command failed: $*"
  sed 's/^/    /' "$output_file" >&2
  rm -f "$output_file"
  exit "$status"
}

check_api_health() {
  local health_url="$1"
  local retries="$2"
  local output_file

  if [ -z "$health_url" ]; then
    log "API health check skipped"
    return
  fi

  output_file="$(mktemp)"
  for attempt in $(seq 1 "$retries"); do
    if curl -fsS --max-time 2 "$health_url" >"$output_file" 2>&1; then
      rm -f "$output_file"
      return
    fi
    sleep 1
  done

  log "❌ API health check failed after $retries attempts: $health_url"
  sed 's/^/    /' "$output_file" >&2
  rm -f "$output_file"
  exit 1
}

restart_pm2_app() {
  local app_name="$1"

  if ! command -v pm2 >/dev/null 2>&1; then
    log "❌ pm2 command not found. Install PM2 or set AIDENTITY_API_RESTART_CMD."
    exit 1
  fi

  if pm2 describe "$app_name" >/dev/null 2>&1; then
    run_quiet pm2 restart "$app_name" --update-env
  else
    run_quiet pm2 start "$repo_root/ecosystem.config.cjs" --only "$app_name"
  fi
  run_quiet pm2 save
}

source_path="${BASH_SOURCE[0]}"
while [ -L "$source_path" ]; do
  source_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
  link_target="$(readlink "$source_path")"
  if [[ "$link_target" == /* ]]; then
    source_path="$link_target"
  else
    source_path="$source_dir/$link_target"
  fi
done

script_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
build_dir="$repo_root/apps/web/dist"

prod_root="${AIDENTITY_WEB_PROD_DIR:-/var/www/aidentity-web}"
releases_dir="$prod_root/releases"
current_link="$prod_root/current"
api_health_url="${AIDENTITY_API_HEALTH_URL:-http://127.0.0.1:4000/api/health}"
api_health_retries="${AIDENTITY_API_HEALTH_RETRIES:-20}"
api_restart_cmd="${AIDENTITY_API_RESTART_CMD:-}"
prod_pm2_api_name="${AIDENTITY_PROD_PM2_API_NAME:-prod-aidentity-api}"
release_name="$(date -u +%Y%m%d%H%M%S)"
release_dir="$releases_dir/$release_name"

export NODE_ENV="${NODE_ENV:-production}"
export VITE_API_URL="${VITE_API_URL:-https://aidentity.tech}"
export VITE_API_PORT="${VITE_API_PORT:-}"

section "Starting deploy"

section "Building API"
run_quiet npm --prefix "$repo_root" --workspace @aidentity/api run build

section "Building web"
run_quiet npm --prefix "$repo_root" --workspace @aidentity/web run build

if [ ! -d "$build_dir" ]; then
  echo "Build output not found: $build_dir" >&2
  exit 1
fi

section "Restarting API"
if [ -n "$api_restart_cmd" ]; then
  run_quiet bash -lc "$api_restart_cmd"
else
  restart_pm2_app "$prod_pm2_api_name"
fi

section "Checking API health"
check_api_health "$api_health_url" "$api_health_retries"

section "Publishing web release"
run_quiet mkdir -p "$release_dir"
run_quiet cp -a "$build_dir"/. "$release_dir"/
run_quiet ln -sfn "$release_dir" "$current_link"

section "Deploy complete"
