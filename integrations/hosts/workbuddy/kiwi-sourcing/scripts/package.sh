#!/usr/bin/env bash
set -euo pipefail

CONNECTOR_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOSITORY_ROOT="$(cd "${CONNECTOR_ROOT}/../../../.." && pwd)"
VERSION="$(node -e 'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "${CONNECTOR_ROOT}/connector-meta.json")"
OUTPUT_DIR="${REPOSITORY_ROOT}/release/workbuddy"
OUTPUT_FILE="${OUTPUT_DIR}/kiwi-sourcing-${VERSION}.zip"
STAGING="$(mktemp -d /tmp/kiwi-workbuddy.XXXXXX)"
trap 'rm -rf "${STAGING}"' EXIT

command -v zip >/dev/null 2>&1 || {
  echo "zip command is required to build the WorkBuddy submission package" >&2
  exit 1
}

node "${CONNECTOR_ROOT}/scripts/validate.mjs"
mkdir -p "${OUTPUT_DIR}"
cp "${CONNECTOR_ROOT}/connector-meta.json" "${STAGING}/"
cp "${CONNECTOR_ROOT}/mcp.json" "${STAGING}/"
cp "${CONNECTOR_ROOT}/icon.svg" "${STAGING}/"
cp "${CONNECTOR_ROOT}/README.md" "${STAGING}/"
cp -R "${CONNECTOR_ROOT}/skills" "${STAGING}/"

rm -f "${OUTPUT_FILE}"
(
  cd "${STAGING}"
  zip -q -r "${OUTPUT_FILE}" connector-meta.json mcp.json icon.svg README.md skills
)

echo "✓ WorkBuddy submission package: ${OUTPUT_FILE}"
