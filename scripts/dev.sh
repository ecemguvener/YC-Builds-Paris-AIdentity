#!/usr/bin/env bash
set -euo pipefail

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

cd "$repo_root"

export WEB_PORT="${AIDENTITY_DEV_WEB_PORT:-4888}"
public_host="${AIDENTITY_PUBLIC_HOST:-100.81.152.74}"
export API_PORT="${AIDENTITY_DEV_API_PORT:-4001}"
export PUBLIC_APP_URL="${AIDENTITY_DEV_PUBLIC_APP_URL:-http://${public_host}:${WEB_PORT}}"
export PUBLIC_API_URL="${AIDENTITY_DEV_PUBLIC_API_URL:-http://${public_host}:${API_PORT}}"
export API_PROXY_TARGET="${AIDENTITY_DEV_API_PROXY_TARGET:-http://127.0.0.1:${API_PORT}}"
export VITE_API_URL="${AIDENTITY_DEV_VITE_API_URL:-}"
export VITE_API_PORT="$API_PORT"

pids=()

cleanup() {
  if [ "${#pids[@]}" -eq 0 ]; then
    return
  fi

  kill "${pids[@]}" 2>/dev/null || true
  wait "${pids[@]}" 2>/dev/null || true
}

stop() {
  trap - EXIT
  cleanup
  exit 130
}

start() {
  printf '== Starting %s ==\n' "$1"
  shift
  "$@" &
  pids+=("$!")
}

trap cleanup EXIT
trap stop INT TERM

start "API dev" npm --workspace @aidentity/api run dev
start "web dev" npm --workspace @aidentity/web run dev

while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      exit $?
    fi
  done

  sleep 1
done
