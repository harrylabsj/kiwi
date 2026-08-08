#!/usr/bin/env bash
# Production package smoke: build, npm pack, install the tarball into a clean
# temp project with --omit=dev, then run the installed CLI and import the
# runtime/schema modules. Catches runtime dependencies that are mistakenly
# declared as devDependencies (they are absent under --omit=dev).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/kiwi-pkg.XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

cd "${ROOT}"
npm run build >/dev/null
PKG="$(npm pack --silent --pack-destination "${WORK}")"
echo "== packed: ${PKG}"

mkdir "${WORK}/app"
cd "${WORK}/app"
npm init -y >/dev/null
npm install --omit=dev "${WORK}/${PKG}" >/dev/null

echo "== installed CLI runs (npm .bin symlink)"
VERSION_OUT="$(./node_modules/.bin/kiwi --version)"
if [[ "${VERSION_OUT}" != "kiwi 0.6.0" ]]; then
  echo "FAIL: 'kiwi --version' printed '${VERSION_OUT}' (expected 'kiwi 0.6.0')" >&2
  exit 1
fi
echo "${VERSION_OUT}"
./node_modules/.bin/kiwi --help | head -1

echo "== runtime modules import with production deps only"
node --input-type=module -e "
  const schemas = await import('@harrylabsj/kiwi/dist/contracts/schemas.js');
  const schema = schemas.loadSchema('decision');
  if (schemas.validateAgainst('decision', {}).length === 0) {
    throw new Error('ajv validator did not reject an empty decision');
  }
  if (!schema) throw new Error('decision schema missing');
  await import('@harrylabsj/kiwi/dist/runtime/tools.js');
  await import('@harrylabsj/kiwi/dist/runtime/merchant-turn.js');
  await import('@harrylabsj/kiwi/dist/runtime/negotiation-turn.js');
  await import('@harrylabsj/kiwi/dist/runtime/foreground.js');
  await import('@harrylabsj/kiwi/dist/runtime/buyer-policy.js');
  await import('@harrylabsj/kiwi/dist/weixin/qr.js');
  await import('@harrylabsj/kiwi/dist/weixin/ilink-client.js');
  await import('@harrylabsj/kiwi/dist/weixin/channel.js');
  await import('@harrylabsj/kiwi/dist/agent/kernel-builder.js');
  await import('@harrylabsj/kiwi/dist/commerce/http-client.js');
  await import('@harrylabsj/kiwi/dist/supervisor/stack-config.js');
  await import('@harrylabsj/kiwi/dist/supervisor/manage.js');
  const { wrapperPath } = await import('@harrylabsj/kiwi/dist/supervisor/manifest.js');
  const { existsSync } = await import('node:fs');
  if (!existsSync(wrapperPath())) throw new Error('child-runner wrapper.js missing from package');
  console.log('production package smoke OK');
"
