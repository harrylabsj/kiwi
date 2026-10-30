#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -gt 1 ]; then
  echo "usage: package.sh [absolute-path-to-new-package.zip]" >&2
  exit 2
fi
CONNECTOR_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOSITORY_ROOT="$(cd "${CONNECTOR_ROOT}/../../../.." && pwd)"
VERSION="$(node -e 'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "${CONNECTOR_ROOT}/connector-meta.json")"
if [ "$#" -eq 1 ]; then
  OUTPUT_FILE="$1"
else
  OUTPUT_FILE="${REPOSITORY_ROOT}/release/workbuddy/kiwi-sourcing-${VERSION}.zip"
fi
case "${OUTPUT_FILE}" in
  /*) ;;
  *) OUTPUT_FILE="${REPOSITORY_ROOT}/${OUTPUT_FILE}" ;;
esac
mkdir -p "$(dirname "${OUTPUT_FILE}")"
exec node "${CONNECTOR_ROOT}/scripts/package-production.mjs" --output "${OUTPUT_FILE}"
