#!/usr/bin/env bash
# Managed-local supervisor E2E (M4): real kiwi init/up/status/logs/down with
# a real shopping-cli API and deterministic fake buyer/merchant agents.
#
# Proves: init -> up (gateway) -> seed -> up (idempotent, +agents) ->
# merchant counter -> buyer accept_nonbinding -> status/logs -> down -> only
# manifest-owned processes die; a separate sentinel survives; down is
# idempotent. Cleans up only its own temp dir and PIDs; the gateway port is
# chosen dynamically by kiwi init.
#
# Usage:
#   bash scripts/e2e-supervisor.sh
#   SHOPPING_CLI_SRC=/path/to/shopping-cli bash scripts/e2e-supervisor.sh
set -euo pipefail

KIWI_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHOPPING_CLI_SRC="${SHOPPING_CLI_SRC:-$(cd "${KIWI_ROOT}/.." && pwd)/shopping-cli}"
WORK="$(mktemp -d /tmp/kiwi-sup-e2e.XXXXXX)"
INSTANCE="${WORK}/instance"
SENTINEL_PID=""

cleanup() {
  # Only ever stop PIDs this script started; only remove its own temp dir.
  if [[ -n "${SENTINEL_PID}" ]] && kill -0 "${SENTINEL_PID}" 2>/dev/null; then
    kill "${SENTINEL_PID}" 2>/dev/null || true
  fi
  # Best-effort: if agents/gateway somehow survived, down again (safe,
  # manifest-verified) rather than killing anything by name.
  node "${KIWI_ROOT}/dist/cli.js" down --dir "${INSTANCE}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

[[ -d "${SHOPPING_CLI_SRC}/shopping_cli" ]] || {
  echo "shopping-cli repo not found at ${SHOPPING_CLI_SRC}" >&2
  exit 1
}
if [[ -x "${SHOPPING_CLI_SRC}/.venv/bin/python" ]]; then
  PY="${SHOPPING_CLI_SRC}/.venv/bin/python"
else
  PY="python3"
  export PYTHONPATH="${SHOPPING_CLI_SRC}"
fi
json_get() { "${PY}" -c "import json,sys;print(json.load(sys.stdin)$1)"; }

echo "== building kiwi"
(cd "${KIWI_ROOT}" && npm run build >/dev/null)

export SHOPPING_ADMIN_TOKEN="kiwi-sup-e2e-admin-0123456789abcdef"
export SHOPPING_BUYER_BOOTSTRAP_TOKEN="kiwi-sup-e2e-bootstrap-0123456789"

echo "== kiwi init (fake models, managed-local)"
node "${KIWI_ROOT}/dist/cli.js" init --dir "${INSTANCE}" \
  --shopping-cli-src "${SHOPPING_CLI_SRC}" --fake >/dev/null
BASE=$(json_get "['gateway']['base_url']" < "${INSTANCE}/kiwi.stack.json")
echo "== instance created, gateway base_url ${BASE}"

echo "== phase 1: up with gateway only (agents temporarily disabled)"
"${PY}" - "${INSTANCE}/kiwi.stack.json" <<'PYEOF'
import json, sys
p = sys.argv[1]
cfg = json.load(open(p))
cfg["agents"]["merchant"]["enabled"] = False
cfg["agents"]["buyer"]["enabled"] = False
json.dump(cfg, open(p, "w"), indent=2)
PYEOF
node "${KIWI_ROOT}/dist/cli.js" up --dir "${INSTANCE}" | json_get "['started']"
curl -sf "${BASE}/health" >/dev/null

echo "== seed merchant / product / policy / conversation"
MERCHANT_TOKEN=$(curl -sf -X POST "${BASE}/merchants" \
  -H "Authorization: Bearer ${SHOPPING_ADMIN_TOKEN}" -H 'content-type: application/json' \
  -d '{"id":"merchant-001","name":"陶瓷小店","city":"上海","service_area":["市区"],"contact":"n/a","hours":"9-18","automation_boundaries":"手写陶瓷杯最低可成交价 80 元","tags":[],"delivery_fee":0,"delivery_eta_minutes":120,"delivery_radius_km":10}' \
  | json_get "['merchant_token']")
curl -sf -X POST "${BASE}/products" \
  -H "Authorization: Bearer ${MERCHANT_TOKEN}" -H 'content-type: application/json' \
  -d '{"merchant_id":"merchant-001","sku":"sku-001","title":"手写陶瓷杯","price":99,"stock":12,"currency":"CNY","category":"厨具","tags":[],"description":"景德镇手工陶瓷杯 350ml","delivery_attributes":[]}' >/dev/null
"${PY}" -m shopping_cli.cli --db "${INSTANCE}/data/shopping.sqlite" policy add \
  --merchant merchant-001 --code return-7d \
  --title "7 天无理由退货" --body "签收后 7 天内支持无理由退货。" >/dev/null
CONV_JSON=$(curl -sf -X POST "${BASE}/conversations" \
  -H "Authorization: Bearer ${SHOPPING_BUYER_BOOTSTRAP_TOKEN}" -H 'content-type: application/json' \
  -d '{"buyer_id":"buyer-001","merchant_id":"merchant-001","sku":"sku-001","text":"买 2 件可以便宜一点吗？","intent":"ask_price"}')
CONV_ID=$(echo "${CONV_JSON}" | json_get "['conversation']['id']")
export SHOPPING_AGENT_TOKEN="${MERCHANT_TOKEN}"
export SHOPPING_BUYER_TOKEN=$(echo "${CONV_JSON}" | json_get "['buyer_token']")
echo "== conversation ${CONV_ID} seeded"

echo "== phase 2: re-enable agents; up is idempotent for the gateway"
"${PY}" - "${INSTANCE}/kiwi.stack.json" <<'PYEOF'
import json, sys
p = sys.argv[1]
cfg = json.load(open(p))
cfg["agents"]["merchant"]["enabled"] = True
cfg["agents"]["buyer"]["enabled"] = True
json.dump(cfg, open(p, "w"), indent=2)
PYEOF
node "${KIWI_ROOT}/dist/cli.js" up --dir "${INSTANCE}" | json_get "['started'], ['already_running']"

GATEWAY_PID=$(json_get "['pid']" < "${INSTANCE}/run/gateway.json")
MERCHANT_PID=$(json_get "['pid']" < "${INSTANCE}/run/merchant.json")
BUYER_PID=$(json_get "['pid']" < "${INSTANCE}/run/buyer.json")
echo "== pids: gateway=${GATEWAY_PID} merchant=${MERCHANT_PID} buyer=${BUYER_PID}"

echo "== waiting for merchant counter then buyer accept (messages >= 3)"
for _ in $(seq 1 60); do
  COUNT=$("${PY}" -c "import sqlite3;print(sqlite3.connect('${INSTANCE}/data/shopping.sqlite').execute('select count(*) from messages where conversation_id=?',('${CONV_ID}',)).fetchone()[0])" 2>/dev/null || echo 0)
  [[ "${COUNT}" -ge 3 ]] && break
  sleep 1
done
[[ "${COUNT}" -ge 3 ]] || { echo "negotiation did not reach 3 messages"; exit 1; }

echo "== kiwi status"
STATUS_JSON=$(node "${KIWI_ROOT}/dist/cli.js" status --dir "${INSTANCE}")
echo "${STATUS_JSON}" | json_get "['ok']"
echo "${STATUS_JSON}" | "${PY}" -c "
import json, sys
s = json.load(sys.stdin)
assert s['ok'] is True, s
assert s['gateway_health']['ok'] is True, s
procs = {p['role']: p for p in s['processes']}
for role in ('gateway', 'merchant', 'buyer'):
    assert procs[role]['running'] and procs[role]['verified'], procs[role]
raw = json.dumps(s)
assert '${SHOPPING_AGENT_TOKEN}' not in raw and '${SHOPPING_BUYER_TOKEN}' not in raw
print('status OK: all processes verified+running, no secrets')
"

echo "== kiwi logs (labeled, redacted)"
LOGS_OUT=$(node "${KIWI_ROOT}/dist/cli.js" logs --dir "${INSTANCE}" --lines 50)
echo "${LOGS_OUT}" | grep -q '^\[merchant\]' || { echo "missing [merchant] log labels"; exit 1; }
echo "${LOGS_OUT}" | grep -q '^\[gateway\]' || { echo "missing [gateway] log labels"; exit 1; }
if echo "${LOGS_OUT}" | grep -q "${SHOPPING_AGENT_TOKEN}\|${SHOPPING_BUYER_TOKEN}\|${SHOPPING_ADMIN_TOKEN}"; then
  echo "logs leaked a token value"; exit 1
fi
echo "logs OK: labeled lines, no token values"

echo "== sentinel process (must survive down)"
sleep 300 &
SENTINEL_PID=$!

echo "== kiwi down"
DOWN_JSON=$(node "${KIWI_ROOT}/dist/cli.js" down --dir "${INSTANCE}")
echo "${DOWN_JSON}" | "${PY}" -c "
import json, sys
d = json.load(sys.stdin)
outcomes = {r['role']: r['outcome'] for r in d['results']}
assert outcomes.get('gateway') == 'stopped', outcomes
assert outcomes.get('merchant') in ('stopped', 'killed'), outcomes
assert outcomes.get('buyer') in ('stopped', 'killed'), outcomes
print('down outcomes:', outcomes)
"
for pid in "${GATEWAY_PID}" "${MERCHANT_PID}" "${BUYER_PID}"; do
  if kill -0 "${pid}" 2>/dev/null; then
    echo "managed pid ${pid} still alive after down"; exit 1
  fi
done
kill -0 "${SENTINEL_PID}" 2>/dev/null || { echo "sentinel was killed"; exit 1; }
echo "down OK: managed processes stopped, sentinel alive"

echo "== kiwi down again (idempotent)"
node "${KIWI_ROOT}/dist/cli.js" down --dir "${INSTANCE}" >/dev/null

echo "== final negotiation assertions"
"${PY}" - "${INSTANCE}/data/shopping.sqlite" "${CONV_ID}" <<'PYEOF'
import json
import sqlite3
import sys

db_path, conv_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
msgs = conn.execute(
    "SELECT structured_payload_json FROM messages WHERE conversation_id=? ORDER BY id",
    (conv_id,),
).fetchall()
assert len(msgs) >= 3, f"expected >=3 messages, got {len(msgs)}"
actions = [
    (json.loads(p[0]).get("decision", {}) if p[0] else {}).get("action") for p in msgs[:3]
]
assert actions[1:] == ["counter", "accept_nonbinding"], actions
procs = conn.execute("SELECT status FROM agent_message_processes").fetchall()
assert procs and all(s == "processed" for (s,) in procs), procs
(stock,) = conn.execute("SELECT stock FROM products WHERE sku='sku-001'").fetchone()
assert stock == 12, stock
tables = [r[0].lower() for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
for banned in ("order", "payment", "reserv"):
    assert not any(banned in t for t in tables), tables
print("SUPERVISOR E2E OK: counter -> accept_nonbinding, claims processed, stock unchanged, no order tables")
PYEOF
