#!/usr/bin/env bash
# Cross-process E2E: real shopping-cli 2.x negotiation API + Kiwi buyer and
# merchant agents (deterministic fake models), over real HTTP.
#
# Proves: buyer message -> merchant counter -> buyer accept_nonbinding.
# Both claims end processed, exactly 3 structured messages, next_actor is
# correct, no duplicates, stock untouched, and the database has no
# order/payment/reservation tables at all.
#
# The script is read-only w.r.t. the shopping-cli repo and cleans up after
# itself: it kills only the server PID it started and removes only its own
# temp dir.
#
# Profiles are generated in the temp dir with this run's selected base URL
# (free loopback port unless PORT is set); committed example profiles are
# never modified and no secrets are written into profiles.
#
# Usage:
#   bash scripts/e2e-local.sh
#   SHOPPING_CLI_SRC=/path/to/shopping-cli PORT=9000 bash scripts/e2e-local.sh
set -euo pipefail

KIWI_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHOPPING_CLI_SRC="${SHOPPING_CLI_SRC:-$(cd "${KIWI_ROOT}/.." && pwd)/shopping-cli}"
WORK="$(mktemp -d /tmp/kiwi-e2e.XXXXXX)"

# Port: explicit PORT wins; otherwise pick a free loopback port so parallel
# or repeated runs never conflict.
if [[ -z "${PORT:-}" ]]; then
  PORT="$(python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()')"
  echo "== selected free loopback port ${PORT} (set PORT to override)"
fi
BASE="http://127.0.0.1:${PORT}"
SERVER_PID=""

cleanup() {
  # Only ever stop the PID this script started; only remove its own temp dir.
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

[[ -d "${SHOPPING_CLI_SRC}/shopping_cli" ]] || {
  echo "shopping-cli repo not found at ${SHOPPING_CLI_SRC} (set SHOPPING_CLI_SRC)" >&2
  exit 1
}

# Python runtime: reuse the shopping-cli repo venv when present (offline
# friendly); otherwise build an isolated venv in the temp dir.
if [[ -x "${SHOPPING_CLI_SRC}/.venv/bin/python" ]]; then
  PY="${SHOPPING_CLI_SRC}/.venv/bin/python"
  unset PYTHONPATH || true
else
  echo "== creating isolated venv in ${WORK}"
  python3 -m venv "${WORK}/venv"
  "${WORK}/venv/bin/pip" install -q uvicorn fastapi
  PY="${WORK}/venv/bin/python"
  export PYTHONPATH="${SHOPPING_CLI_SRC}"
fi

echo "== building kiwi"
(cd "${KIWI_ROOT}" && npm run build >/dev/null)

export SHOPPING_ADMIN_TOKEN="kiwi-e2e-admin-token-0123456789abcdef"
export SHOPPING_BUYER_BOOTSTRAP_TOKEN="kiwi-e2e-buyer-bootstrap-0123456789"
export SHOPPING_DEPLOYMENT_PROFILE=local
SHOPPING_DB="${WORK}/shopping.sqlite"

echo "== starting shopping-cli API on ${BASE} (db: ${SHOPPING_DB})"
"${PY}" -m shopping_cli.api.server --db "${SHOPPING_DB}" --host 127.0.0.1 --port "${PORT}" \
  >"${WORK}/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -sf "${BASE}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "${BASE}/health" >/dev/null || { echo "server did not start"; cat "${WORK}/server.log"; exit 1; }

json_get() { "${PY}" -c "import json,sys;print(json.load(sys.stdin)$1)"; }

echo "== capabilities (real endpoint)"
curl -sf "${BASE}/capabilities" | json_get "['capabilities']['protocol_versions']"

echo "== bootstrap merchant / product / policy / conversation"
MERCHANT_TOKEN=$(curl -sf -X POST "${BASE}/merchants" \
  -H "Authorization: Bearer ${SHOPPING_ADMIN_TOKEN}" -H 'content-type: application/json' \
  -d '{"id":"merchant-001","name":"陶瓷小店","city":"上海","service_area":["市区"],"contact":"n/a","hours":"9-18","automation_boundaries":"手写陶瓷杯最低可成交价 80 元","tags":[],"delivery_fee":0,"delivery_eta_minutes":120,"delivery_radius_km":10}' \
  | json_get "['merchant_token']")

curl -sf -X POST "${BASE}/products" \
  -H "Authorization: Bearer ${MERCHANT_TOKEN}" -H 'content-type: application/json' \
  -d '{"merchant_id":"merchant-001","sku":"sku-001","title":"手写陶瓷杯","price":99,"stock":12,"currency":"CNY","category":"厨具","tags":[],"description":"景德镇手工陶瓷杯 350ml","delivery_attributes":[]}' >/dev/null

"${PY}" -m shopping_cli.cli --db "${SHOPPING_DB}" policy add \
  --merchant merchant-001 --code return-7d \
  --title "7 天无理由退货" --body "签收后 7 天内支持无理由退货。" >/dev/null

CONV_JSON=$(curl -sf -X POST "${BASE}/conversations" \
  -H "Authorization: Bearer ${SHOPPING_BUYER_BOOTSTRAP_TOKEN}" -H 'content-type: application/json' \
  -d '{"buyer_id":"buyer-001","merchant_id":"merchant-001","sku":"sku-001","text":"买 2 件可以便宜一点吗？","intent":"ask_price"}')
CONV_ID=$(echo "${CONV_JSON}" | json_get "['conversation']['id']")
BUYER_TOKEN=$(echo "${CONV_JSON}" | json_get "['buyer_token']")
echo "== conversation ${CONV_ID} created with buyer ask (message 1)"

export SHOPPING_AGENT_TOKEN="${MERCHANT_TOKEN}"
export SHOPPING_BUYER_TOKEN="${BUYER_TOKEN}"

# Temporary profiles bound to THIS run's base URL. Committed example
# profiles are never modified; secrets stay in env vars (the profiles only
# name the env vars), and the files die with the temp dir.
MERCHANT_PROFILE="${WORK}/merchant.e2e.yaml"
BUYER_PROFILE="${WORK}/buyer.e2e.yaml"
cat >"${MERCHANT_PROFILE}" <<EOF
runtime_version: 0.1.0
protocol_version: shopping.negotiation/0.1
agent_id: merchant-agent:merchant-001
role: merchant
owner_id: merchant-001
commerce:
  base_url: ${BASE}
  token_env: SHOPPING_AGENT_TOKEN
  backend: local_marketplace
model:
  provider: fake
  model: fake-merchant-model
runtime:
  mode: once
  poll_interval_seconds: 5
  turn_timeout_seconds: 90
  max_model_steps: 4
  max_retries: 2
merchant_policy:
  min_unit_price_private: 80.00
  max_auto_discount_percent: 10
  inventory_source: marketplace
  quote_ttl_seconds: 300
  auto_negotiate: true
  human_review_on:
    - below_floor
    - exceptional_warranty
    - suspicious_content
EOF
cat >"${BUYER_PROFILE}" <<EOF
runtime_version: 0.1.0
protocol_version: shopping.negotiation/0.1
agent_id: buyer-agent:buyer-001
role: buyer
owner_id: buyer-001
commerce:
  base_url: ${BASE}
  token_env: SHOPPING_BUYER_TOKEN
  backend: local_marketplace
model:
  provider: fake
  model: fake-buyer-model
runtime:
  mode: once
  poll_interval_seconds: 5
  turn_timeout_seconds: 90
  max_model_steps: 4
  max_retries: 2
buyer_policy:
  target_skus:
    - sku-001
  quantity: 2
  max_total_price_private: 200.00
  acceptable_eta_latest: "2099-12-31T23:59:59+08:00"
  required_after_sales_terms:
    - policy:return-7d
  auto_negotiate: true
  human_review_on:
    - budget_exceeded
    - ambiguous_after_sales
EOF

echo "== kiwi doctor (merchant)"
node "${KIWI_ROOT}/dist/cli.js" doctor --profile "${MERCHANT_PROFILE}" >/dev/null

echo "== kiwi merchant fake --once (expect counter, message 2)"
node "${KIWI_ROOT}/dist/cli.js" agent run --profile "${MERCHANT_PROFILE}" --once

echo "== kiwi buyer fake --once (expect accept_nonbinding, message 3)"
node "${KIWI_ROOT}/dist/cli.js" agent run --profile "${BUYER_PROFILE}" --once

echo "== kiwi buyer fake --once again (expect no_work, no duplicate write)"
node "${KIWI_ROOT}/dist/cli.js" agent run --profile "${BUYER_PROFILE}" --once

echo "== final assertions against the real database"
"${PY}" - "${SHOPPING_DB}" "${CONV_ID}" <<'PYEOF'
import json
import sqlite3
import sys

db_path, conv_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Exactly 3 structured messages: buyer ask, merchant counter, buyer accept.
msgs = cur.execute(
    "SELECT sender, structured_payload_json FROM messages WHERE conversation_id=? ORDER BY id",
    (conv_id,),
).fetchall()
assert len(msgs) == 3, f"expected 3 messages, got {len(msgs)}"
actions = []
for _sender, payload in msgs:
    data = json.loads(payload) if payload else {}
    actions.append(data.get("decision", {}).get("action"))
# The buyer's opening message is a plain consultation; the two agent turns
# must be the structured counter and accept_nonbinding.
assert actions[1:] == ["counter", "accept_nonbinding"], actions
# No duplicate writes: ids are unique by construction; verify idempotency keys distinct.
keys = [
    json.loads(payload).get("idempotency_key")
    for _s, payload in msgs
    if payload and json.loads(payload).get("idempotency_key")
]
assert len(keys) == len(set(keys)), f"duplicate idempotency keys: {keys}"

# Conversation routed back to the merchant; still just a negotiation.
status, next_actor = cur.execute(
    "SELECT status, next_actor FROM conversations WHERE id=?", (conv_id,)
).fetchone()
assert status == "waiting_merchant", status
assert next_actor == "merchant_agent", next_actor

# Both claims processed (merchant on msg 2, buyer on msg 3... claim rows are
# keyed by the claimed inbound message: 1 for merchant, 2 for buyer).
procs = cur.execute(
    "SELECT agent_id, status FROM agent_message_processes ORDER BY message_id"
).fetchall()
assert len(procs) == 2, procs
assert all(s == "processed" for _a, s in procs), procs
agents = sorted(a for a, _s in procs)
assert agents == [
    "shopping-cli-buyer-agent:buyer-001",
    "shopping-cli-merchant-agent:merchant-001",
], agents

# Stock untouched; negotiation never reserves.
(stock,) = cur.execute("SELECT stock FROM products WHERE sku='sku-001'").fetchone()
assert stock == 12, stock

# No order/payment/reservation tables exist at all (structural no-order boundary).
tables = [r[0].lower() for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
for banned in ("order", "payment", "reserv"):
    assert not any(banned in t for t in tables), f"forbidden table matching {banned}: {tables}"

# Audit chain complete.
events = [
    r[0]
    for r in cur.execute(
        "SELECT event FROM audit_events WHERE conversation_id=?", (conv_id,)
    )
]
for expected in (
    "agent_message_claimed",
    "negotiation_decision_submitted",
    "negotiation_policy_accepted",
    "agent_message_processed",
):
    assert expected in events, f"{expected} missing from {events}"
assert events.count("negotiation_policy_accepted") == 2, events

print(
    "E2E OK: buyer ask -> merchant counter -> buyer accept_nonbinding; "
    "3 messages, next_actor=merchant_agent, 2 claims processed, "
    "stock=12, no order/payment/reservation tables"
)
PYEOF
