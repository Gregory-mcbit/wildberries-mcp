#!/usr/bin/env sh
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required: https://nodejs.org/" >&2
  exit 1
fi
exec node "$(dirname "$0")/install.mjs" "$@"
