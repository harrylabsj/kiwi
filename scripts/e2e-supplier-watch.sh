#!/usr/bin/env bash
# Cross-process E2E for the M1 supplier observation chain (commit 6e790d1):
#   buyer supplier watch → SupplierScheduler tick → real HTTP pull of
#   catalog record/listings + Agent Card + UCP profile → supplier_observations.
#
# Everything runs over real loopback HTTP against real processes:
#   - a real kiwi-catalog service (sibling repo, read-only) with one
#     registered merchant record and one published listing;
#   - a minimal merchant stub serving /.well-known/agent-card.json and
#     /.well-known/ucp (its access log doubles as the structural proof that
#     the buyer only ever sends plain GETs, with no stable buyer identity
#     headers — pull-relationship §9.2);
#   - a real buyer data dir initialized by `kiwi buyer start` (non-interactive:
#     stdin EOF exits the chat loop right after kernel open), watched via the
#     real CLI, then ticked through AgentKernel.schedulerTick against the same
#     state.sqlite.
#
# SSRF note: SupplierScheduler defaults allowLoopback=false (untrusted Agent
# Cards must not target loopback). The negative phase below proves that guard
# really fires on the real path; the positive phases pass the documented
# local-development escape hatch allowLoopback:true, exactly as a developer
# running a local merchant would. No protection is disabled globally.
#
# The script cleans up after itself: it kills only the PIDs it started and
# removes only its own temp dir. Sibling repos stay read-only.
#
# Usage:
#   bash scripts/e2e-supplier-watch.sh
#   KIWI_CATALOG_DIR=/path/to/kiwi-catalog bash scripts/e2e-supplier-watch.sh
set -euo pipefail

KIWI_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KIWI_CATALOG_DIR="${KIWI_CATALOG_DIR:-$(cd "${KIWI_ROOT}/.." && pwd)/kiwi-catalog}"
WORK="$(mktemp -d /tmp/kiwi-e2e-supplier.XXXXXX)"

CATALOG_PID=""
MERCHANT_PID=""

cleanup() {
  local rc=$?
  for pid in "${MERCHANT_PID}" "${CATALOG_PID}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
    fi
  done
  if [[ ${rc} -ne 0 ]]; then
    echo "== E2E failed (rc=${rc}); last catalog log lines:" >&2
    tail -n 30 "${WORK}/catalog.log" 2>/dev/null || true
    echo "== last merchant log lines:" >&2
    tail -n 30 "${WORK}/merchant.log" 2>/dev/null || true
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

free_port() {
  python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()'
}

json_get() { python3 -c "import json,sys;print(json.load(sys.stdin)$1)"; }

[[ -f "${KIWI_CATALOG_DIR}/pyproject.toml" ]] || {
  echo "kiwi-catalog repo not found at ${KIWI_CATALOG_DIR} (set KIWI_CATALOG_DIR)" >&2
  exit 1
}
if [[ -x "${KIWI_CATALOG_DIR}/.venv/bin/python" ]]; then
  PY="${KIWI_CATALOG_DIR}/.venv/bin/python"
else
  PY="python3"
fi

echo "== building kiwi"
(cd "${KIWI_ROOT}" && npm run build >/dev/null)

CATALOG_PORT="$(free_port)"
MERCHANT_PORT="$(free_port)"
CATALOG_URL="http://127.0.0.1:${CATALOG_PORT}"
MERCHANT_URL="http://127.0.0.1:${MERCHANT_PORT}"
MERCHANT_ID="mrc_e2e_supplier"
echo "== catalog :${CATALOG_PORT}  merchant-stub :${MERCHANT_PORT}  work ${WORK}"

# --------------------------------------------------------------------------
# 1. Local merchant stub: serves the Agent Card / UCP profile from files in
#    WORK (so the script can mutate them between ticks) and logs every
#    request method+path+identity-header presence for the §9.2 assertion.
# --------------------------------------------------------------------------
cat >"${WORK}/merchant-server.mjs" <<EOF
import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";

const cardPath = process.env.MERCHANT_CARD_PATH;
const ucpPath = process.env.MERCHANT_UCP_PATH;
const accessLog = process.env.MERCHANT_ACCESS_LOG;

const server = createServer((req, res) => {
  const hasBuyerId = req.headers["x-buyer-id"] !== undefined ? 1 : 0;
  appendFileSync(accessLog, \`\${req.method} \${req.url} x-buyer-id=\${hasBuyerId} ua=\${req.headers["user-agent"] ?? ""}\n\`);
  const send = (file) => {
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  };
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (req.url === "/.well-known/agent-card.json") return send(cardPath);
  if (req.url === "/.well-known/ucp") return send(ucpPath);
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
server.listen(Number(process.env.MERCHANT_PORT), "127.0.0.1");
EOF

write_agent_card() { # $1 = version
  cat >"${WORK}/agent-card.json" <<EOF
{
  "name": "E2E Supplier",
  "description": "E2E supplier-watch test merchant agent",
  "provider": { "organization": "E2E Supplier Co." },
  "version": "$1",
  "url": "${MERCHANT_URL}/",
  "supportedInterfaces": [
    { "url": "${MERCHANT_URL}/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "0.3" }
  ],
  "capabilities": { "streaming": false },
  "skills": [
    { "id": "shopping-negotiation", "name": "Shopping negotiation", "tags": ["shopping"] }
  ],
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"]
}
EOF
}

write_agent_card "1.0.0"
cat >"${WORK}/ucp.json" <<EOF
{ "ucp": { "version": "0.1" }, "merchant": { "id": "${MERCHANT_ID}", "name": "E2E Supplier Co." } }
EOF
: >"${WORK}/merchant-access.log"

MERCHANT_CARD_PATH="${WORK}/agent-card.json" \
MERCHANT_UCP_PATH="${WORK}/ucp.json" \
MERCHANT_ACCESS_LOG="${WORK}/merchant-access.log" \
MERCHANT_PORT="${MERCHANT_PORT}" \
  node "${WORK}/merchant-server.mjs" >"${WORK}/merchant.log" 2>&1 &
MERCHANT_PID=$!
for _ in $(seq 1 40); do
  curl -sf "${MERCHANT_URL}/.well-known/agent-card.json" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "${MERCHANT_URL}/.well-known/agent-card.json" >/dev/null || {
  echo "merchant stub did not start"; cat "${WORK}/merchant.log"; exit 1; }
# The readiness probe above is this script's own fetch; reset the access log
# so later assertions only see scheduler/buyer traffic.
: >"${WORK}/merchant-access.log"

# --------------------------------------------------------------------------
# 2. Real kiwi-catalog service + one merchant record + one listing.
# --------------------------------------------------------------------------
export KIWI_CATALOG_ADMIN_TOKEN="kiwi-e2e-supplier-admin-0123456789ab"
export KIWI_CATALOG_OWNER_TOKEN_SECRET="kiwi-e2e-supplier-owner-0123456789"
PYTHONPATH="${KIWI_CATALOG_DIR}" "${PY}" -m kiwi_catalog.scripts.kiwi_catalog_api \
  --db "${WORK}/catalog.sqlite" --host 127.0.0.1 --port "${CATALOG_PORT}" \
  >"${WORK}/catalog.log" 2>&1 &
CATALOG_PID=$!
for _ in $(seq 1 60); do
  curl -sf "${CATALOG_URL}/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "${CATALOG_URL}/health" >/dev/null || {
  echo "kiwi-catalog did not start"; cat "${WORK}/catalog.log"; exit 1; }

OWNER_TOKEN="$(PYTHONPATH="${KIWI_CATALOG_DIR}" "${PY}" -c "from kiwi_catalog.api.auth import owner_token; print(owner_token('${MERCHANT_ID}'))")"

echo "== registering merchant record in local catalog"
python3 - "${MERCHANT_URL}" "${MERCHANT_ID}" "${OWNER_TOKEN}" <<'PYEOF' >"${WORK}/register.json"
import json, sys
merchant_url, merchant_id, owner_token = sys.argv[1:4]
print(json.dumps({
    "domain": "127.0.0.1",
    "display_name": "E2E Supplier Co.",
    "agent_card_url": f"{merchant_url}/.well-known/agent-card.json",
    "ucp_profile_url": f"{merchant_url}/.well-known/ucp",
    "merchant_id": merchant_id,
    "owner_token": owner_token,
    "hosting_mode": "direct_only",
    "capabilities": ["com.harrylabsj.kiwi.shopping.negotiation"],
    "handoff_destination_types": ["external_checkout_url"],
}))
PYEOF
REGISTER_JSON="$(curl -sf -X POST "${CATALOG_URL}/v1/agents/register" \
  -H 'content-type: application/json' \
  --data-binary @"${WORK}/register.json")"
echo "${REGISTER_JSON}" | json_get "['ok']" | grep -q True
CAGT_ID="$(echo "${REGISTER_JSON}" | json_get "['agent']['catalog_agent_id']")"
# 本地 fixture 无公网 DNS 验证；显式把 record 提升到已验证状态，以测试 Buyer
# 对 verified+fresh+active 治理门后的真实 pull 路径。
python3 - "${WORK}/catalog.sqlite" "${CAGT_ID}" <<'PYEOF'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("UPDATE catalog_agents SET verification_level='domain_verified' WHERE catalog_agent_id=?", (sys.argv[2],))
conn.commit()
PYEOF
echo "== registered ${MERCHANT_ID} -> ${CAGT_ID}"

# Cross-origin negative fixture: canonical cross-origin.example, identity endpoint 127.0.0.1.
# Catalog may store it, but Buyer relationship creation must fail closed.
python3 - "${MERCHANT_URL}" <<'PYEOF' >"${WORK}/register-cross-origin.json"
import json, sys
merchant_url = sys.argv[1]
print(json.dumps({
    "domain": "cross-origin.example",
    "display_name": "Cross Origin Fixture",
    "agent_card_url": f"{merchant_url}/.well-known/agent-card.json",
    "hosting_mode": "direct_only",
}))
PYEOF
BAD_REGISTER_JSON="$(curl -sf -X POST "${CATALOG_URL}/v1/agents/register" \
  -H 'content-type: application/json' --data-binary @"${WORK}/register-cross-origin.json")"
BAD_CAGT_ID="$(echo "${BAD_REGISTER_JSON}" | json_get "['agent']['catalog_agent_id']")"
python3 - "${WORK}/catalog.sqlite" "${BAD_CAGT_ID}" <<'PYEOF'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("UPDATE catalog_agents SET verification_level='domain_verified' WHERE catalog_agent_id=?", (sys.argv[2],))
conn.commit()
PYEOF

publish_listing() { # $1 = availability_hint, $2 = lead_time_hint
  python3 - "${CAGT_ID}" "${MERCHANT_ID}" "${OWNER_TOKEN}" "$1" "$2" <<'PYEOF' >"${WORK}/publish.json"
import json, sys
cagt_id, merchant_id, owner_token, availability, lead_time = sys.argv[1:6]
print(json.dumps({
    "listing_type": "product",
    "owner_agent_id": cagt_id,
    "merchant_id": merchant_id,
    "owner_token": owner_token,
    "source_product_ref": "SKU-E2E-1",
    "title": "21.5 inch Industrial Touch Display",
    "category": "industrial-display",
    "brand": "E2E Display Co.",
    "attributes": {"screen_size": "21.5"},
    "regions": ["CN"],
    "tags": ["touch"],
    "commercial_hints": {"moq": 10, "availability_hint": availability, "lead_time_hint": lead_time},
    "handoff_destination_types": ["external_checkout_url"],
}))
PYEOF
  curl -sf -X POST "${CATALOG_URL}/v1/listings/publish" \
    -H 'content-type: application/json' \
    --data-binary @"${WORK}/publish.json"
}

echo "== publishing listing (availability=in_stock)"
PUBLISH_JSON="$(publish_listing in_stock 7d)"
LISTING_ID="$(echo "${PUBLISH_JSON}" | json_get "['listing']['listing_id']")"
echo "== listing ${LISTING_ID}"

# --------------------------------------------------------------------------
# 3. Buyer data dirs via the real non-interactive init path:
#    `kiwi buyer start` opens the AgentKernel (creating state.sqlite +
#    buyer principal) and the chat loop exits cleanly on stdin EOF.
#    NEG dir backs the SSRF fail-closed phase.
# --------------------------------------------------------------------------
BUYER_DIR="${WORK}/buyer"
NEG_DIR="${WORK}/buyer-neg"
echo "== initializing buyer data dirs (buyer start --no-a2a, stdin EOF)"
node "${KIWI_ROOT}/dist/cli.js" buyer start \
  --profile "${KIWI_ROOT}/examples/profiles/buyer.fake.yaml" \
  --data-dir "${BUYER_DIR}" --no-a2a </dev/null >"${WORK}/buyer-init.log" 2>&1
node "${KIWI_ROOT}/dist/cli.js" buyer start \
  --profile "${KIWI_ROOT}/examples/profiles/buyer.fake.yaml" \
  --data-dir "${NEG_DIR}" --no-a2a </dev/null >"${WORK}/buyer-neg-init.log" 2>&1

echo "== cross-origin relationship creation must fail closed"
if node "${KIWI_ROOT}/dist/cli.js" buyer supplier save "${BAD_CAGT_ID}" \
  --catalog "${CATALOG_URL}" --data-dir "${BUYER_DIR}" >"${WORK}/bad-save.out" 2>"${WORK}/bad-save.err"; then
  echo "cross-origin supplier save unexpectedly succeeded" >&2
  exit 1
fi
grep -q "does not match canonical_domain" "${WORK}/bad-save.err"
echo "OK: cross-origin catalog endpoint rejected before relationship creation"

# --------------------------------------------------------------------------
# 4. Real CLI: buyer supplier watch (both dirs).
# --------------------------------------------------------------------------
echo "== kiwi buyer supplier watch ${CAGT_ID}"
WATCH_JSON="$(node "${KIWI_ROOT}/dist/cli.js" buyer supplier watch "${CAGT_ID}" \
  --yes --catalog "${CATALOG_URL}" --data-dir "${BUYER_DIR}")"
REL_ID="$(echo "${WATCH_JSON}" | json_get "['relationship']['relationship_id']")"
node "${KIWI_ROOT}/dist/cli.js" buyer supplier watch "${CAGT_ID}" \
  --yes --catalog "${CATALOG_URL}" --data-dir "${NEG_DIR}" >/dev/null
echo "== relationship ${REL_ID}"

python3 - "${BUYER_DIR}/state.sqlite" "${REL_ID}" <<'PYEOF'
import sqlite3, sys
db, rel = sys.argv[1], sys.argv[2]
row = sqlite3.connect(db).execute(
    "SELECT relationship_type, status, merchant_id, consent_source, expires_at "
    "FROM supplier_relationships WHERE relationship_id=?", (rel,)).fetchone()
assert row is not None, "no supplier_relationships row after watch"
assert row[0] == "watched" and row[1] == "active", row
assert row[2] == "mrc_e2e_supplier", row
assert row[3] == "human_explicit", row
assert row[4], "watched relationship must have a default expiry"
print("OK: watched+active relationship row (consent human_explicit)")
PYEOF

# --------------------------------------------------------------------------
# 5. Supplier tick driver: opens the real AgentKernel and calls schedulerTick.
#    --offset-hours moves the
#    injected clock forward so due-checks fire without waiting 6h.
# --------------------------------------------------------------------------
cat >"${WORK}/supplier-tick.mjs" <<EOF
import { ensurePathsForDir } from "${KIWI_ROOT}/dist/agent/agent-db.js";
import { FakeCommerceConnector } from "${KIWI_ROOT}/dist/agent/connector/fake-connector.js";
import { createFakeChatModels } from "${KIWI_ROOT}/dist/agent/fake-chat-model.js";
import { AgentKernel } from "${KIWI_ROOT}/dist/agent/kernel.js";
import { loadProfile } from "${KIWI_ROOT}/dist/config/profile.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const dataDir = opt("--data-dir", undefined);
const catalog = opt("--catalog", undefined);
const allowLoopback = args.includes("--allow-loopback");
const offsetHours = Number(opt("--offset-hours", "0"));

const { models, model } = createFakeChatModels();
const kernel = await AgentKernel.open({
  profile: loadProfile("${KIWI_ROOT}/examples/profiles/buyer.fake.yaml"),
  paths: ensurePathsForDir(dataDir),
  models,
  model,
  connector: new FakeCommerceConnector(),
  catalog,
  now: () => new Date(Date.now() + offsetHours * 3600_000).toISOString(),
  ...(allowLoopback ? { allowLoopback: true } : {}),
});
try {
  const tick = await kernel.schedulerTick();
  if (tick.supplier === undefined) throw new Error("kernel did not construct supplier scheduler");
  const supplier = tick.supplier;
  supplier.kernel_requests_used = tick.requests_used + supplier.requests_used;
  console.log(JSON.stringify(supplier));
} finally {
  await kernel.close();
}
EOF

run_tick() { # $1 = data dir, $2 = offset hours, extra args after
  local dir="$1" offset="$2"; shift 2
  node "${WORK}/supplier-tick.mjs" --data-dir "${dir}" --catalog "${CATALOG_URL}" \
    --offset-hours "${offset}" "$@" 2>"${WORK}/tick.stderr.log"
}

# --------------------------------------------------------------------------
# 6. Negative phase: default allowLoopback=false must fail closed on the
#    real loopback Agent Card (SSRF guard actually fires; not bypassed).
# --------------------------------------------------------------------------
echo "== negative tick (default policy must reject loopback Agent Card)"
NEG_TICK="$(run_tick "${NEG_DIR}" 0)"
echo "${NEG_TICK}" | python3 -c "
import json, sys
r = json.load(sys.stdin)
assert r['checked'] == 1, r
assert r['observations'] == [], r['observations']
errs = ' | '.join(r['errors'])
assert 'agent_card' in errs and 'safety policy' in errs and 'loopback' in errs, errs
print('OK: default SSRF policy rejected loopback Agent Card:', errs)
"

# --------------------------------------------------------------------------
# 7. Baseline tick: first successful pull records fingerprints/snapshots
#    silently (no observations yet).
# --------------------------------------------------------------------------
echo "== tick 1 (baseline)"
TICK1="$(run_tick "${BUYER_DIR}" 0 --allow-loopback)"
echo "${TICK1}" | python3 -c "
import json, sys
r = json.load(sys.stdin)
assert r['checked'] == 1, r
assert r['errors'] == [], r['errors']
assert r['observations'] == [], ('baseline must stay silent', r['observations'])
print('OK: baseline tick checked=1, no errors, no observations')
"
python3 - "${BUYER_DIR}/state.sqlite" "${REL_ID}" <<'PYEOF'
import sqlite3, sys
db, rel = sys.argv[1], sys.argv[2]
rows = {r[0]: (r[1], r[2]) for r in sqlite3.connect(db).execute(
    "SELECT source_type, COALESCE(last_success_at,''), COALESCE(last_verified_fingerprint,'') "
    "FROM supplier_observation_state WHERE relationship_id=?", (rel,)).fetchall()}
for src in ("catalog_search", "agent_card", "ucp_profile"):
    assert src in rows, f"missing state row for {src}: {rows}"
    assert rows[src][0], f"{src} last_success_at empty"
assert rows["agent_card"][1], "agent_card fingerprint not recorded"
print("OK: state rows for catalog_search/agent_card/ucp_profile; agent card fingerprint recorded")
PYEOF
python3 - "${BUYER_DIR}" "${WORK}/trust-baseline.txt" <<'PYEOF'
import glob, json, sys
files = glob.glob(sys.argv[1] + "/trust/trust-*.json")
assert len(files) == 1, files
r = json.load(open(files[0]))
open(sys.argv[2], "w").write(r["agent_card_fingerprint"])
PYEOF

# --------------------------------------------------------------------------
# 8. Listing diff: republish with changed commercial_hints → next tick must
#    produce availability/lead-time/listing_updated observations.
# --------------------------------------------------------------------------
echo "== republish listing (availability=backorder, lead_time=21d)"
publish_listing backorder 21d >/dev/null

echo "== tick 2 (expect listing diff observations)"
run_tick "${BUYER_DIR}" 7 --allow-loopback >"${WORK}/tick2.json"
python3 - "${WORK}/tick2.json" "${LISTING_ID}" <<'PYEOF'
import json, sys
listing_id = sys.argv[2]
with open(sys.argv[1]) as f:
    r = json.load(f)
assert r["checked"] == 1, r
assert r["errors"] == [], r["errors"]
kinds = sorted((o["kind"], o["source_type"]) for o in r["observations"])
assert ("availability_hint_changed", "catalog_search") in kinds, kinds
assert ("lead_time_hint_changed", "catalog_search") in kinds, kinds
assert ("listing_updated", "catalog_search") in kinds, kinds
for o in r["observations"]:
    if o["kind"] == "availability_hint_changed":
        assert o["payload"] == {"listing_id": listing_id, "from": "in_stock", "to": "backorder"}, o["payload"]
print("OK: listing diff observations:", [k for k, _ in kinds])
PYEOF
python3 - "${BUYER_DIR}/state.sqlite" "${REL_ID}" <<'PYEOF'
import sqlite3, sys
status = sqlite3.connect(sys.argv[1]).execute(
    "SELECT status FROM supplier_relationships WHERE relationship_id=?", (sys.argv[2],)).fetchone()[0]
assert status == "active", status
print("OK: relationship still active after listing diff")
PYEOF

# --------------------------------------------------------------------------
# 9. Identity diff: bump Agent Card version → fingerprint change →
#    profile_or_identity_changed + review_required; afterwards the
#    relationship must drop out of the due set entirely.
# --------------------------------------------------------------------------
echo "== bump agent card version 1.0.0 -> 1.1.0"
write_agent_card "1.1.0"

echo "== tick 3 (expect profile_or_identity_changed + review_required)"
TICK3="$(run_tick "${BUYER_DIR}" 20 --allow-loopback)"
echo "${TICK3}" | python3 -c "
import json, sys
r = json.load(sys.stdin)
assert r['checked'] == 1, r
hits = [o for o in r['observations'] if o['kind'] == 'profile_or_identity_changed']
assert len(hits) == 1, r['observations']
assert hits[0]['source_type'] == 'agent_card', hits
assert hits[0]['payload']['from'] != hits[0]['payload']['to'], hits[0]['payload']
print('OK: profile_or_identity_changed (fingerprint', hits[0]['payload']['from'][:12] + '…', '->', hits[0]['payload']['to'][:12] + '…)')
"
python3 - "${BUYER_DIR}/state.sqlite" "${REL_ID}" <<'PYEOF'
import sqlite3, sys
status = sqlite3.connect(sys.argv[1]).execute(
    "SELECT status FROM supplier_relationships WHERE relationship_id=?", (sys.argv[2],)).fetchone()[0]
assert status == "review_required", status
print("OK: relationship entered review_required")
PYEOF
python3 - "${BUYER_DIR}" "${WORK}/trust-baseline.txt" <<'PYEOF'
import glob, json, sys
r = json.load(open(glob.glob(sys.argv[1] + "/trust/trust-*.json")[0]))
baseline = open(sys.argv[2]).read()
assert r["agent_card_fingerprint"] == baseline, (baseline, r["agent_card_fingerprint"])
assert r["successful_exchanges"] == 2, r
print("OK: identity mismatch did not overwrite trusted fingerprint or count as exchange success")
PYEOF

echo "== tick 4 (review_required must halt automatic pulls)"
TICK4="$(run_tick "${BUYER_DIR}" 27 --allow-loopback)"
echo "${TICK4}" | python3 -c "
import json, sys
r = json.load(sys.stdin)
assert r['checked'] == 0, r
assert r['observations'] == [], r['observations']
print('OK: review_required relationship no longer polled (checked=0)')
"

# --------------------------------------------------------------------------
# 10. Structural assertions: the merchant stub saw only plain GETs from the
#     scheduler, never an X-Buyer-Id identity header (§9.2). Fetch counts
#     match the pull semantics exactly: agent card fetched on every due tick
#     (baseline + listing-diff + identity-diff = 3), UCP profile only on
#     ticks 1-2 — tick 3's fingerprint change puts the relationship into
#     review_required and skips the remaining sources (§8 第 5 步).
# --------------------------------------------------------------------------
python3 - "${WORK}/merchant-access.log" <<'PYEOF'
import sys
lines = [l.strip() for l in open(sys.argv[1]) if l.strip()]
assert lines, "merchant stub saw no traffic — scheduler never fetched over HTTP"
for l in lines:
    assert l.startswith("GET "), f"non-GET request from buyer side: {l}"
    assert "x-buyer-id=0" in l, f"stable buyer identity header leaked: {l}"
card_gets = [l for l in lines if l.startswith("GET /.well-known/agent-card.json")]
ucp_gets = [l for l in lines if l.startswith("GET /.well-known/ucp")]
assert len(card_gets) == 3, f"expected exactly 3 agent card fetches (tick1-3), got {len(card_gets)}: {lines}"
assert len(ucp_gets) == 2, (
    f"expected exactly 2 ucp fetches (tick3 halts before ucp after fingerprint change), "
    f"got {len(ucp_gets)}: {lines}"
)
assert all("ua=kiwi-buyer" in l for l in lines), lines
print(f"OK: merchant access log = {len(card_gets)}x agent-card + {len(ucp_gets)}x ucp GETs, "
      "no non-GET, no X-Buyer-Id")
PYEOF

echo "E2E OK: watch → real catalog/agent-card/ucp pull → baseline state; listing diff → observations; identity diff → review_required + halt; SSRF default rejects loopback"
