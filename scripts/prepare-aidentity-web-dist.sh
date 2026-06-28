#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
build_dir="$repo_root/apps/web/dist"
homepage_dir="$repo_root/apps/web/public/aidentity-homepage"

if [ ! -f "$build_dir/index.html" ]; then
  echo "Web app build index not found: $build_dir/index.html" >&2
  exit 1
fi

if [ ! -f "$homepage_dir/index.html" ]; then
  echo "Homepage export not found: $homepage_dir/index.html" >&2
  exit 1
fi

cp "$build_dir/index.html" "$build_dir/app.html"
cp -R "$homepage_dir"/. "$build_dir"/
