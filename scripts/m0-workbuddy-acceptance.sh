#!/usr/bin/env bash
# M0 本地端到端验收：临时 kiwi-catalog v30 + curl 断言 + 真实 Kiwi Buyer MCP 工具。
# 默认自行启动仅绑定 127.0.0.1 的 catalog；也可设置 M0_CATALOG_URL 指向已启动的本地实例。
# 不接触生产数据，不打印验证码、cookie 或会话 token。
set -euo pipefail
umask 077

kiwi_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
catalog_repo="${M0_CATALOG_REPO:-$(cd "$kiwi_repo/../kiwi-catalog" && pwd)}"
catalog_url="${M0_CATALOG_URL:-http://127.0.0.1:18617}"
case "$catalog_url" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) printf 'M0_CATALOG_URL must be a local loopback HTTP URL\n' >&2; exit 2 ;;
esac
case "$catalog_url" in */) catalog_url="${catalog_url%/}" ;; esac

for bin in curl jq sqlite3 node openssl; do
  command -v "$bin" >/dev/null || { printf 'missing command: %s\n' "$bin" >&2; exit 2; }
done
test -f "$kiwi_repo/dist/cli.js" || { printf 'build Kiwi first: npm run build\n' >&2; exit 2; }

case_dir="$(mktemp -d /private/tmp/kiwi-m0-e2e.XXXXXX)"
catalog_pid=""
cleanup() {
  if [[ -n "$catalog_pid" ]]; then
    kill "$catalog_pid" 2>/dev/null || true
    wait "$catalog_pid" 2>/dev/null || true
  fi
  case "$case_dir" in
    /private/tmp/kiwi-m0-e2e.*) rm -rf -- "$case_dir" ;;
  esac
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }
request() {
  local method="$1" path="$2" expected="$3" body="${4:-}" cookie="${5:-}"
  local args=(-sS --connect-timeout 3 --max-time 15 -D "$case_dir/headers" -o "$case_dir/response.json" -w '%{http_code}' -X "$method")
  if [[ -n "$body" ]]; then args+=(-H 'Content-Type: application/json' --data "$body"); fi
  if [[ -n "$cookie" ]]; then args+=(-H "Cookie: $cookie"); fi
  local status
  status="$(curl "${args[@]}" "$catalog_url$path")" || fail "$method $path network error"
  [[ "$status" == "$expected" ]] || fail "$method $path: HTTP $status, expected $expected (body: $(jq -c 'del(.verification_code)' "$case_dir/response.json" 2>/dev/null || echo unreadable))"
}
session_cookie() {
  sed -n 's/^[Ss]et-[Cc]ookie:[[:space:]]*\([^;]*\).*/\1/p' "$case_dir/headers" | tr -d '\r' | head -1
}
mcp_call() {
  local name="$1" args="$2" line response
  line="$(jq -cn --arg name "$name" --argjson args "$args" '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:$name,arguments:$args}}')"
  response="$({
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"kiwi-m0-acceptance","version":"1"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    printf '%s\n' "$line"
  } | node "$kiwi_repo/dist/cli.js" mcp serve --db "$case_dir/buyer.sqlite" --principal 'buyer:m0-acceptance' --catalog-url "$catalog_url" 2>"$case_dir/mcp.stderr" | jq -sc '.[-1]')" || fail "MCP call $name failed"
  jq -e '.id == 2 and .result.content[0].text != null' >/dev/null <<<"$response" || fail "MCP call $name returned no tool result"
  printf '%s\n' "$response"
}

if [[ -z "${M0_CATALOG_URL:-}" ]]; then
  test -x "$catalog_repo/.venv/bin/kiwi-catalog-api" || fail "missing $catalog_repo/.venv/bin/kiwi-catalog-api"
  port="${catalog_url##*:}"
  if curl -fsS --max-time 1 "$catalog_url/health" >/dev/null 2>&1; then
    fail "port $port already serves a catalog; set M0_CATALOG_URL explicitly or free the port"
  fi
  local_secret="$(openssl rand -hex 32)"
  KIWI_CATALOG_OWNER_TOKEN_SECRET="$local_secret" KIWI_CATALOG_EMAIL_VERIFICATION_MODE=console \
    "$catalog_repo/.venv/bin/kiwi-catalog-api" --db "$case_dir/catalog.sqlite" --host 127.0.0.1 --port "$port" >"$case_dir/catalog.log" 2>&1 &
  catalog_pid="$!"
  ready=0
  for _ in {1..30}; do
    if curl -fsS --max-time 1 "$catalog_url/health" >/dev/null 2>&1; then ready=1; break; fi
    kill -0 "$catalog_pid" 2>/dev/null || break
    sleep 0.2
  done
  [[ "$ready" == 1 ]] || fail "local catalog did not start (see catalog.log in temporary case directory)"
fi
request GET /health 200
pass 'local catalog responds'

case_tag="$(openssl rand -hex 5)"
merchant_email="m0-merchant-$case_tag@example.invalid"
buyer_email="m0-buyer-$case_tag@example.invalid"
password="$(openssl rand -hex 16)"
shop_name="M0 验收商家 $case_tag"
product_name="M0 验收保温杯 $case_tag"

register_account() {
  local email="$1" name="$2" payload code cookie
  payload="$(jq -cn --arg name "$name" --arg email "$email" --arg password "$password" '{merchant_name:$name,email:$email,password:$password,phone:"+86 138 0000 0000"}')"
  request POST /v1/accounts/register 200 "$payload"
  code="$(jq -r '.verification_code // empty' "$case_dir/response.json")"
  [[ -n "$code" ]] || fail 'test catalog must use console email verification mode'
  payload="$(jq -cn --arg email "$email" --arg code "$code" '{email:$email,code:$code}')"
  request POST /v1/accounts/verify-email 200 "$payload"
  cookie="$(session_cookie)"
  [[ "$cookie" == kiwi_session=* ]] || fail 'verification did not set kiwi_session cookie'
  printf '%s\n' "$cookie"
}

merchant_cookie="$(register_account "$merchant_email" "$shop_name")"
buyer_cookie="$(register_account "$buyer_email" 'M0 验收买家')"
request GET /v1/accounts/me 200 '' "$merchant_cookie"
merchant_id="$(jq -r '.merchant_id // empty' "$case_dir/response.json")"
[[ -n "$merchant_id" ]] || fail 'merchant_id missing after registration'
if [[ -n "$catalog_pid" ]]; then
  schema_version="$(sqlite3 "$case_dir/catalog.sqlite" "select value from meta where key='schema_version';" 2>/dev/null || true)"
  [[ "$schema_version" == 30 ]] || fail "catalog schema is $schema_version, expected 30"
  pass 'temporary catalog database uses schema v30'
fi
pass 'merchant registered and verified with stable merchant_id'

encoded_product="$(jq -nr --arg text "$product_name" '$text|@uri')"
payload="$(jq -cn --arg name "$shop_name" --arg title "$product_name" '{action:"draft",merchant_display_name:$name,title:$title,category:"日用品",summary:"M0 测试资料"}')"
request POST /v1/merchant-publications 200 "$payload" "$merchant_cookie"
publication_id="$(jq -r '.publication.publication_id // empty' "$case_dir/response.json")"
[[ -n "$publication_id" ]] || fail 'draft response lacks publication_id'
request GET "/v1/merchant-publications/search?q=$encoded_product" 200
jq -e --arg id "$publication_id" '[.results[] | select(.publication_id==$id)] | length == 0' "$case_dir/response.json" >/dev/null || fail 'draft leaked into public search'
pass 'draft is not searchable'

payload="$(jq -cn --arg name "$shop_name" --arg title "$product_name" '{action:"publish",merchant_display_name:$name,title:$title,category:"日用品",summary:"M0 测试资料"}')"
request POST /v1/merchant-publications 200 "$payload" "$merchant_cookie"
jq -e --arg id "$publication_id" '.publication.publication_id==$id and .publication.status=="published"' "$case_dir/response.json" >/dev/null || fail 'publication receipt invalid'
pass 'merchant explicitly published product basics and got publication_id receipt'

request GET "/v1/merchant-publications/search?q=$encoded_product" 200
jq -e --arg id "$publication_id" --arg mid "$merchant_id" '.results[] | select(.publication_id==$id and .merchant_id==$mid and .inquiry_available==false and .source_kind=="merchant_declared" and .updated_at!="")' "$case_dir/response.json" >/dev/null || fail 'catalog public search did not return M0 merchant'
search_result="$(mcp_call kiwi_search "$(jq -cn --arg query "$product_name" '{query:$query}')")"
search_text="$(jq -r '.result.content[0].text' <<<"$search_result")"
jq -e --arg mid "$merchant_id" '.merchants[] | select(.merchant_id==$mid and .inquiry_available==false)' <<<"$search_text" >/dev/null || fail 'kiwi_search did not discover M0 merchant'
pass 'kiwi_search found M0 merchant with inquiry_available=false'

task_count_before="$(sqlite3 "$case_dir/buyer.sqlite" 'select count(*) from mcp_tasks;')"
intent="$(jq -cn --arg id "intent-$case_tag" --arg query "$product_name" '{intent_id:$id,intent_type:"purchase",items:[{query:$query,quantity:{value:1,unit:"个"}}],constraints:{currency:"CNY"},context_projection:{disclosure_boundary:"commerce_required",projected_fields:["items","constraints"]}}')"
rfq_args="$(jq -cn --arg mid "$merchant_id" --argjson intent "$intent" '{merchant_ids:[$mid],intent:$intent,idempotency_key:"m0-no-rfq-test"}')"
rfq_result="$(mcp_call kiwi_request_quotes "$rfq_args")"
jq -e '.result.isError==true and (.result.content[0].text | contains("merchant_inquiry_unavailable"))' <<<"$rfq_result" >/dev/null || fail 'M0 RFQ was not rejected with merchant_inquiry_unavailable'
task_count_after="$(sqlite3 "$case_dir/buyer.sqlite" 'select count(*) from mcp_tasks;')"
[[ "$task_count_before" == "$task_count_after" ]] || fail 'RFQ rejection created a task'
pass 'M0 RFQ rejected before task creation'

export KIWI_CATALOG_SESSION="${buyer_cookie#kiwi_session=}"
follow_args="$(jq -cn --arg mid "$merchant_id" '{merchant_id:$mid,consent_version:"m0-test"}')"
follow_result="$(mcp_call kiwi_follow_merchant "$follow_args")"
jq -e '.result.isError!=true and (.result.content[0].text|fromjson|.follow.status)=="active"' <<<"$follow_result" >/dev/null || fail 'buyer follow failed'
pass 'buyer explicitly followed merchant'

sleep 1
payload="$(jq -cn --arg name "$shop_name" --arg title "$product_name" '{action:"publish",merchant_display_name:$name,title:$title,category:"日用品",summary:"M0 更新后的公开资料"}')"
request POST /v1/merchant-publications 200 "$payload" "$merchant_cookie"
updates_result="$(mcp_call kiwi_get_follow_updates '{}')"
jq -e '.result.isError!=true and ([.result.content[0].text|fromjson|.updates[].events[].event_type] | index("product_updated") != null)' <<<"$updates_result" >/dev/null || fail 'product_updated not pulled'
pass 'buyer pulled product_updated after publication change'

sleep 1
payload="$(jq -cn --arg name "$shop_name" --arg title "$product_name" '{action:"publish",merchant_display_name:$name,title:$title,category:"日用品",summary:"M0 更新后的公开资料",faq:[{question:"是否有售后说明？",answer:"请以店铺公布的政策为准。"}]}')"
request POST /v1/merchant-publications 200 "$payload" "$merchant_cookie"
updates_result="$(mcp_call kiwi_get_follow_updates '{}')"
jq -e '.result.isError!=true and ([.result.content[0].text|fromjson|.updates[].events[].event_type] | index("faq_updated") != null)' <<<"$updates_result" >/dev/null || fail 'faq_updated not pulled'
pass 'buyer pulled faq_updated after FAQ change'

unfollow_result="$(mcp_call kiwi_unfollow_merchant "$(jq -cn --arg mid "$merchant_id" '{merchant_id:$mid}')")"
jq -e '.result.isError!=true and (.result.content[0].text|fromjson|.following)==false' <<<"$unfollow_result" >/dev/null || fail 'unfollow failed'
payload="$(jq -cn --arg name "$shop_name" --arg title "$product_name" '{action:"publish",merchant_display_name:$name,title:$title,category:"日用品",summary:"取消关注后的更新",faq:[{question:"是否有售后说明？",answer:"请以店铺公布的政策为准。"}]}')"
request POST /v1/merchant-publications 200 "$payload" "$merchant_cookie"
updates_result="$(mcp_call kiwi_get_follow_updates '{}')"
jq -e '.result.isError!=true and (.result.content[0].text|fromjson|.updates|length)==0' <<<"$updates_result" >/dev/null || fail 'updates still visible after unfollow'
pass 'unfollow removed merchant from subsequent pulled updates'

printf 'PASS: local M0 API + buyer MCP checks completed; publication_id=%s\n' "$publication_id"
printf 'MANUAL: WorkBuddy preview must verify /portal/register → /portal/publications, expert kiwi_search and first-bind behavior.\n'
