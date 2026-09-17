#!/usr/bin/env bash
# 商家连接器（「Kiwi 商家运营」）跨仓端到端验收。
#
# 起三个本地进程，跑通完整链路并断言：
#   真实 kiwi-catalog（临时库）+ 网关入口（kiwi merchant gateway serve）+ 桩商家实例
#
#   商家身份闭环：无会话 authorize → /connect → 目录注册/登录/确认 → 一次性 code
#     → 网关兑换 merchant_id 与商家目录凭据 → 会话 → 授权同意 → 授权码 → token
#   第 0 版目录能力：草稿（私有，采购专家搜不到）→ 请求发布（仍不发布）→
#     商家在门户确认发布 → 公开搜索可见且 inquiry_available=false
#   第 1 版实例路由：商家在 /instance 页面自助绑定实例（URL + 内部令牌 + 探活），
#     工具清单随即出现实例工具，调用带该商家内部凭据打到实例
#   租户隔离：未绑定的商家 B 看不到实例工具，且实例从未收到 B 的请求
#   解绑：解绑后实例工具消失，第 0 版目录能力不受影响
#   配对码：真实 CLI 生成一次性码 → 网关兑换（复用真实实现）→ 工具恢复；重用被拒
#   离线恢复：实例重启（配对凭据落盘）与网关重启（凭据加密库 + OAuth 令牌落盘）后
#     商家无需重新配对即可继续使用；目录能力同样不受影响
#   7×24：网关停止期间商家实例仍对外服务（不依赖 Buddy 窗口）
#   A/B 隔离：两个独立实例各自配对、各自路由，凭据互不通用
#
# 仅使用 loopback 地址与临时目录；不接触生产数据，不打印凭据明文。
set -euo pipefail
umask 077

kiwi_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
catalog_repo="${V1_CATALOG_REPO:-$(cd "$kiwi_repo/../kiwi-catalog" && pwd)}"
catalog_port="${V1_CATALOG_PORT:-18620}"
gateway_port="${V1_GATEWAY_PORT:-18621}"
instance_port="${V1_INSTANCE_PORT:-18622}"

connector_token="v1-acceptance-connector-token"
credential_key="v1-acceptance-credential-key"
instance_token="v1-acceptance-instance-token"
owner_secret="v1-acceptance-owner-secret"
password="acceptance-pw-123"
callback="workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback"
# 查询串里的 redirect_uri 必须整体百分号编码：服务端按「解码后的值 == 注册值」比较，
# 而注册值本身带 %3A（与平台回调格式一致）；手工拼转义易错，统一走 jq @uri。
callback_query="$(printf '%s' "${callback}" | jq -sRr @uri)"
verifier="v1-acceptance-verifier-0123456789abcdef0123456789"

for bin in curl jq node openssl lsof; do
  command -v "$bin" >/dev/null || { printf 'missing command: %s\n' "$bin" >&2; exit 2; }
done
test -f "${kiwi_repo}/dist/cli.js" || { printf 'build Kiwi first: npm run build\n' >&2; exit 2; }
test -d "${catalog_repo}" || { printf 'kiwi-catalog repo not found: %s\n' "${catalog_repo}" >&2; exit 2; }
if [[ -x "${catalog_repo}/.venv/bin/python" ]]; then
  catalog_python="${catalog_repo}/.venv/bin/python"
elif [[ -x "${catalog_repo}/.venv/bin/python3" ]]; then
  catalog_python="${catalog_repo}/.venv/bin/python3"
else
  catalog_python="python3"
fi

# 端口预检：避免复用到上一轮遗留的孤儿进程（那会让断言跑在旧数据上）。
for p in "${catalog_port}" "${gateway_port}" "${instance_port}"; do
  if lsof -ti "tcp:${p}" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'port %s is already in use (leftover process?)\n' "${p}" >&2
    exit 2
  fi
done

case_dir="$(mktemp -d /private/tmp/kiwi-v1-e2e.XXXXXX)"
pids=()
cleanup() {
  # 先全部 TERM，再逐个 wait；等进程真正退出、再删临时目录——否则被 kill 的
  # catalog 仍可能重新落盘 SQLite 文件，留下残骸。
  for pid in "${pids[@]:-}"; do
    [[ -n "${pid}" ]] || continue
    kill "${pid}" 2>/dev/null || true
  done
  for pid in "${pids[@]:-}"; do
    [[ -n "${pid}" ]] || continue
    wait "${pid}" 2>/dev/null || true
  done
  sleep 1
  # 排障用：V1_KEEP_CASE_DIR=1 时保留证据目录（含三个进程的日志）。
  if [[ "${V1_KEEP_CASE_DIR:-0}" == "1" ]]; then
    printf '（已保留证据目录：%s）\n' "${case_dir}"
    return 0
  fi
  case "${case_dir}" in
    /private/tmp/kiwi-v1-e2e.*) rm -rf -- "${case_dir}" ;;
  esac
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }
note() { printf '  · %s\n' "$*"; }
body() { cat "${case_dir}/body" 2>/dev/null || true; }

catalog_url="http://127.0.0.1:${catalog_port}"
gateway_url="http://127.0.0.1:${gateway_port}"

# http <method> <url> [body] [cookie] [authorization]
# 结果：$case_dir/body（JSON）、$case_dir/headers；返回 HTTP 状态码。
http() {
  local method="$1" url="$2" body_arg="${3:-}" cookie="${4:-}" auth="${5:-}"
  local args=(-sS --connect-timeout 3 --max-time 20 -D "${case_dir}/headers" -o "${case_dir}/body"
              -w '%{http_code}' -X "${method}")
  [[ -n "${body_arg}" ]] && args+=(-H 'content-type: application/json' --data "${body_arg}")
  [[ -n "${cookie}" ]] && args+=(-H "Cookie: ${cookie}")
  [[ -n "${auth}" ]] && args+=(-H "Authorization: ${auth}")
  curl "${args[@]}" "${url}" || fail "${method} ${url} network error"
}

# 表单提交（OAuth 端点是 application/x-www-form-urlencoded，不能用 JSON 体）。
http_form() { # <url> <form body> [cookie]
  local url="$1" form="$2" cookie="${3:-}"
  local args=(-sS --connect-timeout 3 --max-time 20 -D "${case_dir}/headers" -o "${case_dir}/body"
              -w '%{http_code}' -X POST -H 'content-type: application/x-www-form-urlencoded' --data "${form}")
  [[ -n "${cookie}" ]] && args+=(-H "Cookie: ${cookie}")
  curl "${args[@]}" "${url}" || fail "POST ${url} network error"
}

header_location() { tr -d '\r' <"${case_dir}/headers" | sed -n 's/^[Ll]ocation:[[:space:]]*\(.*\)$/\1/p' | head -1; }
header_cookie() { tr -d '\r' <"${case_dir}/headers" | sed -n 's/^[Ss]et-[Cc]ookie:[[:space:]]*\([^;]*\).*/\1/p' | head -1; }

wait_health() { # <url> <label>
  for _ in $(seq 1 60); do
    if curl -sS --connect-timeout 2 --max-time 5 "$1" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  fail "$2 did not become healthy ($1)"
}

# ── 1. 真实 kiwi-catalog（临时库，console 邮箱验证）────────────────────────
(
  cd "${catalog_repo}"
  exec env \
    KIWI_CATALOG_CONNECTOR_TOKEN="${connector_token}" \
    KIWI_CATALOG_CONNECTOR_RETURN_URLS="${gateway_url}" \
    KIWI_CATALOG_PUBLIC_BASE_URL="${catalog_url}" \
    KIWI_CATALOG_EMAIL_VERIFICATION_MODE=console \
    KIWI_CATALOG_OWNER_TOKEN_SECRET="${owner_secret}" \
    "${catalog_python}" -m kiwi_catalog.scripts.kiwi_catalog_api \
      --db "${case_dir}/catalog.sqlite" --host 127.0.0.1 --port "${catalog_port}"
) >"${case_dir}/catalog.log" 2>&1 &
pids+=("$!")
wait_health "${catalog_url}/health" "kiwi-catalog"
pass "kiwi-catalog 起在 ${catalog_url}（临时库，仅 loopback）"

# ── 2. 注册商家（A 稍后配对实例；B 不配对，用于隔离断言）──────────────────
register_merchant() { # <email> <name> <label>
  local email="$1" name="$2" label="$3" status cookie merchant_id code
  status=$(http POST "${catalog_url}/v1/accounts/register" \
    "{\"merchant_name\":\"${name}\",\"email\":\"${email}\",\"password\":\"${password}\",\"phone\":\"+86 138 0000 0000\"}")
  [[ "${status}" == "200" ]] || fail "register ${email}: HTTP ${status} $(body)"
  code=$(jq -r '.verification_code' "${case_dir}/body")
  status=$(http POST "${catalog_url}/v1/accounts/verify-email" "{\"email\":\"${email}\",\"code\":\"${code}\"}")
  [[ "${status}" == "200" ]] || fail "verify ${email}: HTTP ${status} $(body)"
  status=$(http POST "${catalog_url}/v1/accounts/login" "{\"email\":\"${email}\",\"password\":\"${password}\"}")
  [[ "${status}" == "200" ]] || fail "login ${email}: HTTP ${status} $(body)"
  cookie="$(header_cookie)"
  status=$(http GET "${catalog_url}/v1/accounts/me" "" "${cookie}")
  [[ "${status}" == "200" ]] || fail "me ${email}: HTTP ${status} $(body)"
  merchant_id=$(jq -r '.merchant_id' "${case_dir}/body")
  [[ "${merchant_id}" == mkt_* ]] || fail "no merchant_id for ${email}: ${merchant_id}"
  printf '%s\n' "${merchant_id}" >"${case_dir}/merchant_${label}.id"
  printf '%s\n' "${cookie}" >"${case_dir}/merchant_${label}.cookie"
}

register_merchant a@acme.example 'Acme 商贸' a
register_merchant b@rival.example 'Rival 商行' b
merchant_a="$(cat "${case_dir}/merchant_a.id")"
merchant_b="$(cat "${case_dir}/merchant_b.id")"
cookie_a="$(cat "${case_dir}/merchant_a.cookie")"
cookie_b="$(cat "${case_dir}/merchant_b.cookie")"
pass "商家 A=${merchant_a} 与 B=${merchant_b} 已注册并验证邮箱"

# ── 3. 桩商家实例（只配给 A）+ 网关入口 ────────────────────────────────────
wait_stub() { # <port>
  # 注意：不能写 `code=$(curl … || echo 000)`——curl 失败时自身已打印 000，
  # 再 echo 会拼成 "000000"，让「未就绪」永远判为就绪（本脚本踩过）。
  local port="$1" code
  for _ in $(seq 1 40); do
    if code=$(curl -sS -o /dev/null -w '%{http_code}' -X GET "http://127.0.0.1:${port}/" 2>/dev/null); then
      [[ "${code}" != "000" ]] && return 0
    fi
    sleep 0.25
  done
  fail "stub 未就绪（http://127.0.0.1:${port}）"
}

# 启动一个桩实例（可多个）：<label> <port> <pairing_dir>；暴露 stub_pid_<label>。
start_stub() {
  local label="$1" port="$2" pairing_dir="$3"
  KIWI_INSTANCE_STUB_TOKEN="${instance_token}" node "${kiwi_repo}/scripts/lib/merchant-instance-stub.mjs" \
    --port "${port}" --merchant-label "${label}" \
    --pairing-dir "${pairing_dir}" >>"${case_dir}/stub.log" 2>&1 &
  local pid=$!
  pids+=("${pid}")
  # 注意：macOS 自带 bash 3.2 没有 `declare -g`，用显式赋值（仅需 A/B 两个）。
  case "${label}" in
    A) stub_pid_A="${pid}" ;;
    B) stub_pid_B="${pid}" ;;
    *) fail "未知 stub 标签：${label}" ;;
  esac
}
start_stub A "${instance_port}" "${case_dir}/instance-pairing"
wait_stub "${instance_port}"
# 第二个独立实例（B 用；A/B 隔离验收）
instance_port_b="${V1_INSTANCE_PORT_B:-18623}"
start_stub B "${instance_port_b}" "${case_dir}/instance-pairing-b"
wait_stub "${instance_port_b}"

start_gateway() {
  (
    cd "${kiwi_repo}"
    exec env \
      KIWI_CATALOG_CONNECTOR_TOKEN="${connector_token}" \
      KIWI_GATEWAY_CREDENTIAL_KEY="${credential_key}" \
      node dist/cli.js merchant gateway serve \
        --public-url "${gateway_url}" --catalog-url "${catalog_url}" \
        --port "${gateway_port}" --data-dir "${case_dir}/gateway"
  ) >>"${case_dir}/gateway.log" 2>&1 &
  gateway_pid=$!
  pids+=("${gateway_pid}")
}
start_gateway
wait_health "${gateway_url}/health" "gateway"
pass "网关入口起在 ${gateway_url}（无静态实例配置；商家走 /instance 自助绑定）"

# MCP 端点要求 Accept 同时含 application/json 与 text/event-stream（SDK 约定）。
http_mcp() { # <json body> [authorization]
  local body_arg="$1" auth="${2:-}"
  local args=(-sS --connect-timeout 3 --max-time 20 -D "${case_dir}/headers" -o "${case_dir}/body"
              -w '%{http_code}' -X POST
              -H 'content-type: application/json'
              -H 'accept: application/json, text/event-stream'
              --data "${body_arg}")
  [[ -n "${auth}" ]] && args+=(-H "Authorization: ${auth}")
  curl "${args[@]}" "${gateway_url}/mcp" || fail "POST /mcp network error"
}

mcp_call() { # <token> <method> [params]
  local token="$1" method="$2" params="${3:-}"
  [[ -n "${params}" ]] || params='{}' # 注意：不能写 "${3:-{}}"，尾部 } 会被当作字面量
  http_mcp "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" "Bearer ${token}"
}

# ── 4. 商家身份闭环（WorkBuddy 客户端 + 商家浏览器）────────────────────────
bind_connector() { # <merchant cookie> <label>
  local cookie="$1" label="$2" status challenge client_id query connect_location login_url
  local request_id redirect_url gw_cookie csrf code
  challenge=$(printf '%s' "${verifier}" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

  status=$(http POST "${gateway_url}/oauth/register" \
    "{\"client_name\":\"WorkBuddy\",\"redirect_uris\":[\"${callback}\"]}")
  [[ "${status}" == "201" ]] || fail "DCR: HTTP ${status} $(body)"
  client_id=$(jq -r '.client_id' "${case_dir}/body")

  query="response_type=code&client_id=${client_id}&redirect_uri=${callback_query}&scope=catalog:read%20catalog:write%20merchant:read%20merchant:write&state=wb-acceptance&code_challenge=${challenge}&code_challenge_method=S256"
  status=$(http GET "${gateway_url}/oauth/authorize?${query}")
  [[ "${status}" == "303" ]] || fail "authorize(无会话): HTTP ${status} $(body)"
  connect_location=$(header_location)
  [[ "${connect_location}" == /connect?next=* ]] || fail "未进入连接流程：${connect_location}"

  status=$(http GET "${gateway_url}${connect_location}")
  [[ "${status}" == "303" ]] || fail "connect: HTTP ${status} $(body)"
  login_url=$(header_location)
  [[ "${login_url}" == "${catalog_url}/portal/connect?request_id="* ]] || fail "未跳到目录连接页：${login_url}"
  request_id="${login_url##*request_id=}"

  status=$(http GET "${catalog_url}/v1/connector-identity/requests/${request_id}" "" "${cookie}")
  [[ "${status}" == "200" ]] || fail "连接请求不可见: HTTP ${status} $(body)"
  [[ "$(jq -r '.request.status' "${case_dir}/body")" == "pending" ]] || fail "连接请求状态异常"

  status=$(http POST "${catalog_url}/v1/connector-identity/requests/${request_id}/decision" \
    '{"decision":"approve"}' "${cookie}")
  [[ "${status}" == "200" ]] || fail "授权确认: HTTP ${status} $(body)"
  redirect_url=$(jq -r '.redirect_url' "${case_dir}/body")

  status=$(http GET "${redirect_url}")
  [[ "${status}" == "303" ]] || fail "回跳网关: HTTP ${status} $(body)"
  gw_cookie=$(header_cookie)
  [[ "${gw_cookie}" == kiwi_admin=* ]] || fail "回跳未建立入口会话"
  printf '%s\n' "${gw_cookie}" >"${case_dir}/gw_cookie_${label}"

  status=$(http GET "${gateway_url}/oauth/authorize?${query}" "" "${gw_cookie}")
  [[ "${status}" == "200" ]] || fail "授权页: HTTP ${status} $(body)"
  csrf=$(sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p' "${case_dir}/body" | head -1)
  [[ -n "${csrf}" ]] || fail "授权页缺 CSRF"

  status=$(http_form "${gateway_url}/oauth/authorize" "csrf=${csrf}&decision=approve" "${gw_cookie}")
  [[ "${status}" == "302" ]] || fail "授权提交: HTTP ${status} $(body)"
  code=$(header_location | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
  [[ -n "${code}" ]] || fail "未返回授权码"

  status=$(http_form "${gateway_url}/oauth/token" \
    "grant_type=authorization_code&code=${code}&client_id=${client_id}&redirect_uri=${callback_query}&code_verifier=${verifier}")
  [[ "${status}" == "200" ]] || fail "换 token: HTTP ${status} $(body)"
  jq -r '.access_token' "${case_dir}/body" >"${case_dir}/token_${label}"
}

bind_connector "${cookie_a}" a
token_a="$(cat "${case_dir}/token_a")"
[[ "${token_a}" == mcp_at_* ]] || fail "A 未取得访问令牌"
pass "商家 A 完成目录连接与授权（一次性 code 单次消费、入口会话已建立）"

# ── 5. 第 0 版目录能力 + 第 1 版实例路由（A）──────────────────────────────
# ── 4.5 商家在网关页面自助绑定实例（§8.4 第一期）────────────────────────────
gw_cookie_a="$(cat "${case_dir}/gw_cookie_a")"
status=$(http GET "${gateway_url}/instance" "" "${gw_cookie_a}")
[[ "${status}" == "200" ]] || fail "绑定页: HTTP ${status} $(body)"
grep -q "连接我的 Kiwi Merchant 服务" "${case_dir}/body" || fail "绑定页内容异常"

status=$(http_form "${gateway_url}/instance/bind" \
  "mcp_url=http://127.0.0.1:${instance_port}/mcp&token=${instance_token}" "${gw_cookie_a}")
[[ "${status}" == "303" ]] || fail "绑定提交: HTTP ${status} $(body)"
[[ "$(header_location)" == "/instance?status=bound" ]] || fail "绑定未成功：$(header_location)"
grep -q '"method":"initialize"' "${case_dir}/stub.log" || fail "绑定未对实例探活（initialize）"
grep -q '"method":"tools/list"' "${case_dir}/stub.log" || fail "绑定未对实例探活（tools/list）"
status=$(http GET "${gateway_url}/instance" "" "${gw_cookie_a}")
grep -q "${instance_port}/mcp" "${case_dir}/body" || fail "绑定页未显示已绑定地址"
if grep -q "${instance_token}" "${case_dir}/body"; then fail "绑定页回显了内部令牌"; fi
# 能力探测：页面显示实例自报版本与探测到的工具数
grep -q "实例版本：merchant-instance-stub-A v0.0.0" "${case_dir}/body" \
  || fail "绑定页未显示实例自报版本：$(grep -o '实例版本：[^<]*' "${case_dir}/body" | head -1)"
grep -q "可用工具：" "${case_dir}/body" || fail "绑定页未显示探测到的工具数"
pass "商家自助绑定实例：URL 策略 + 探活通过，令牌加密保存且不回显（含版本/工具数）"

status=$(mcp_call "${token_a}" tools/list)
[[ "${status}" == "200" ]] || fail "tools/list: HTTP ${status} $(body)"
tools=$(jq -r '.result.tools[].name' "${case_dir}/body" | sort | tr '\n' ' ')
note "A 可见工具：${tools}"
for expected in kiwi_catalog_get_merchant_profile kiwi_catalog_save_publication_draft \
                kiwi_catalog_request_publish kiwi_catalog_get_publication_status \
                kiwi_catalog_withdraw_publication kiwi_merchant_list_products \
                kiwi_merchant_prepare_product_change; do
  grep -q "${expected}" <<<"${tools}" || fail "A 的工具清单缺 ${expected}"
done
pass "工具清单 = 第 0 版目录工具 + 已配对实例工具"

status=$(mcp_call "${token_a}" tools/call '{"name":"kiwi_catalog_save_publication_draft","arguments":{"merchant_display_name":"Acme 商贸","title":"V1 验收明前龙井","summary":"验收用公开简介"}}')
[[ "${status}" == "200" ]] || fail "保存草稿: HTTP ${status} $(body)"
draft_payload=$(jq -r '.result.content[0].text' "${case_dir}/body")
publication_id=$(jq -r '.publication_id' <<<"${draft_payload}")
[[ "${publication_id}" == mpub_* ]] || fail "草稿未返回 publication_id: ${draft_payload}"
[[ "$(jq -r '.status' <<<"${draft_payload}")" == "draft" ]] || fail "草稿状态异常"
pass "第 0 版目录工具经商家目录凭据写入草稿（${publication_id}）"

q=$(printf 'V1 验收明前龙井' | jq -sRr @uri)
status=$(http GET "${catalog_url}/v1/merchant-publications/search?q=${q}")
[[ "${status}" == "200" ]] || fail "公开搜索: HTTP ${status} $(body)"
[[ "$(jq -r '.results | length' "${case_dir}/body")" == "0" ]] || fail "草稿不应出现在公开搜索中"
pass "草稿不出现在公开搜索（采购专家搜不到）"

status=$(mcp_call "${token_a}" tools/call '{"name":"kiwi_catalog_request_publish","arguments":{"merchant_display_name":"Acme 商贸","title":"V1 验收明前龙井","summary":"验收用公开简介"}}')
[[ "${status}" == "200" ]] || fail "请求发布: HTTP ${status} $(body)"
publish_payload=$(jq -r '.result.content[0].text' "${case_dir}/body")
[[ "$(jq -r '.status' <<<"${publish_payload}")" == "draft" ]] || fail "request_publish 不应改变发布状态"
grep -q '尚未发布' <<<"${publish_payload}" || fail "request_publish 未提示需商家确认"
status=$(http GET "${catalog_url}/v1/merchant-publications/search?q=${q}")
[[ "$(jq -r '.results | length' "${case_dir}/body")" == "0" ]] || fail "request_publish 之后仍不应公开"
pass "request_publish 只产草稿 + 门户确认入口（模型不能自批发布）"

status=$(mcp_call "${token_a}" tools/call '{"name":"kiwi_merchant_list_products","arguments":{}}')
[[ "${status}" == "200" ]] || fail "实例工具调用: HTTP ${status} $(body)"
instance_payload=$(jq -r '.result.content[0].text' "${case_dir}/body")
[[ "$(jq -r '.instance' <<<"${instance_payload}")" == "A" ]] || fail "实例工具未路由到 A 的实例: ${instance_payload}"
grep -q '"method":"tools/call"' "${case_dir}/stub.log" || fail "实例未收到 tools/call"
if grep -q "stub_rejected" "${case_dir}/stub.log"; then fail "实例拒绝了网关凭据"; fi
pass "第 1 版路由：调用带该商家内部凭据打到其自托管实例"

requests_after_a=$(grep -c "stub_request" "${case_dir}/stub.log" || true)

# ── 6. 商家在门户确认发布 → 公开可见（买方口径）────────────────────────────
status=$(http POST "${catalog_url}/v1/merchant-publications" \
  "{\"action\":\"publish\",\"merchant_display_name\":\"Acme 商贸\",\"title\":\"V1 验收明前龙井\",\"summary\":\"验收用公开简介\"}" "${cookie_a}")
[[ "${status}" == "200" ]] || fail "门户确认发布: HTTP ${status} $(body)"
published_id=$(jq -r '.publication.publication_id' "${case_dir}/body")
[[ "${published_id}" == "${publication_id}" ]] || fail "确认发布未落到同一 publication（${published_id} vs ${publication_id}）"
pass "商家在门户确认后发布（${published_id}，version=$(jq -r '.publication.version' "${case_dir}/body")）"

status=$(http GET "${catalog_url}/v1/merchant-publications/search?q=${q}")
[[ "${status}" == "200" ]] || fail "发布后搜索: HTTP ${status} $(body)"
jq -e --arg m "${merchant_a}" '.results | length == 1 and .[0].merchant_id == $m
    and .[0].source_kind == "merchant_declared" and .[0].inquiry_available == false' \
  "${case_dir}/body" >/dev/null || fail "发布后搜索结果不符：$(body)"
pass "买方口径可搜到：商家声明来源、inquiry_available=false（不可实时询价）"

# ── 7. 租户隔离：未配对实例的商家 B ────────────────────────────────────────
bind_connector "${cookie_b}" b
token_b="$(cat "${case_dir}/token_b")"
status=$(mcp_call "${token_b}" tools/list)
[[ "${status}" == "200" ]] || fail "B tools/list: HTTP ${status} $(body)"
tools_b=$(jq -r '.result.tools[].name' "${case_dir}/body" | tr '\n' ' ')
grep -q "kiwi_catalog_save_publication_draft" <<<"${tools_b}" || fail "B 应可用第 0 版目录工具"
if grep -q "kiwi_merchant_" <<<"${tools_b}"; then fail "B 未配对实例却看到实例工具：${tools_b}"; fi

status=$(mcp_call "${token_b}" tools/call '{"name":"kiwi_catalog_save_publication_draft","arguments":{"merchant_display_name":"Rival 商行","title":"B 的草稿"}}')
[[ "${status}" == "200" ]] || fail "B 保存草稿: HTTP ${status} $(body)"
[[ "$(jq -r '.result.content[0].text | fromjson | .merchant_id' "${case_dir}/body")" == "${merchant_b}" ]] \
  || fail "B 的草稿未归属 B"
requests_after_b=$(grep -c "stub_request" "${case_dir}/stub.log" || true)
[[ "${requests_after_b}" == "${requests_after_a}" ]] || fail "B 的调用打到了 A 的实例（隔离被破坏）"
pass "未配对商家 B：第 0 版可用、无实例工具、实例从未收到 B 的请求"

# ── 8. 反向断言：无令牌调用被拒 ────────────────────────────────────────────
status=$(http_mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
[[ "${status}" == "401" ]] || fail "无令牌调用应为 401，实得 ${status}"
grep -q 'resource_metadata' "${case_dir}/headers" || fail "401 未携带 resource_metadata 指引"
pass "无令牌 /mcp 返回 401 且指引 OAuth 元数据"

# ── 9. 解绑：实例工具消失，第 0 版不受影响 ─────────────────────────────────
status=$(http_form "${gateway_url}/instance/unbind" "" "${gw_cookie_a}")
[[ "${status}" == "303" ]] || fail "解绑: HTTP ${status} $(body)"
status=$(mcp_call "${token_a}" tools/list)
[[ "${status}" == "200" ]] || fail "解绑后 tools/list: HTTP ${status} $(body)"
tools_after_unbind=$(jq -r '.result.tools[].name' "${case_dir}/body" | tr '\n' ' ')
grep -q "kiwi_catalog_save_publication_draft" <<<"${tools_after_unbind}" || fail "解绑不应影响第 0 版工具"
if grep -q "kiwi_merchant_" <<<"${tools_after_unbind}"; then fail "解绑后仍有实例工具：${tools_after_unbind}"; fi
pass "解绑后实例工具消失，第 0 版目录工具仍可用"

# ── 10. 重新绑定：一次性配对码（§8.4 第二期）──────────────────────────────
# 用**真实 CLI** 在实例侧生成配对码（同一份 pairing.json 语义），桩用真实实现兑换。
KIWI_MERCHANT_MCP_TOKEN="${instance_token}" node "${kiwi_repo}/dist/cli.js" merchant mcp pair \
  --profile "${kiwi_repo}/examples/profiles/merchant.fake.yaml" \
  --data-dir "${case_dir}/instance-pairing" >"${case_dir}/pair.out" 2>&1
pair_code=$(sed -n 's/.*配对码：[[:space:]]*\([A-Z0-9-]*\).*/\1/p' "${case_dir}/pair.out" | head -1)
[[ -n "${pair_code}" ]] || fail "未取得配对码：$(cat "${case_dir}/pair.out")"

status=$(http_form "${gateway_url}/instance/pair" \
  "mcp_url=http://127.0.0.1:${instance_port}/mcp&code=${pair_code}" "${gw_cookie_a}")
[[ "${status}" == "303" ]] || fail "配对绑定: HTTP ${status} $(body)"
[[ "$(header_location)" == "/instance?status=paired" ]] || fail "配对绑定未成功：$(header_location) $(body)"
grep -q '"method":"pairing/redeem"' "${case_dir}/stub.log" || fail "实例未收到配对兑换请求"
grep -q "stub_issued_paired_credential" "${case_dir}/stub.log" || fail "实例未签发配对凭据"
status=$(mcp_call "${token_a}" tools/list)
tools_after_pair=$(jq -r '.result.tools[].name' "${case_dir}/body" | tr '\n' ' ')
grep -q "kiwi_merchant_list_products" <<<"${tools_after_pair}" || fail "配对绑定后缺实例工具：${tools_after_pair}"

# 调用一次实例工具：网关必须改用**配对凭据**（而不是静态令牌）打到实例。
status=$(mcp_call "${token_a}" tools/call '{"name":"kiwi_merchant_list_products","arguments":{}}')
[[ "${status}" == "200" ]] || fail "配对后实例工具调用: HTTP ${status} $(body)"
tail -n 20 "${case_dir}/stub.log" | grep -q '"kind":"paired"' \
  || fail "配对后网关未使用配对凭据（仍用静态令牌？）"
pass "配对码绑定：真实 CLI 生成码 → 网关兑换新签凭据 → 实例工具恢复并用配对凭据调用"

status=$(http_form "${gateway_url}/instance/pair" \
  "mcp_url=http://127.0.0.1:${instance_port}/mcp&code=${pair_code}" "${gw_cookie_a}")
[[ "$(header_location)" == *"error="* ]] || fail "配对码重用未被拒绝：$(header_location)"
pass "配对码单次有效：同一码再次兑换被拒绝"

# ── 11. 离线恢复：实例重启 / 网关重启后无需重新配对 ───────────────────────
kill "${stub_pid_A}" 2>/dev/null || true
wait "${stub_pid_A}" 2>/dev/null || true
sleep 1
start_stub A "${instance_port}" "${case_dir}/instance-pairing"
wait_stub "${instance_port}"
status=$(mcp_call "${token_a}" tools/call '{"name":"kiwi_merchant_list_products","arguments":{}}')
[[ "${status}" == "200" ]] || fail "实例重启后调用: HTTP ${status} $(body)"
[[ "$(jq -r '.result.isError // false' "${case_dir}/body")" != "true" ]] \
  || fail "实例重启后调用失败：$(jq -r '.result.content[0].text' "${case_dir}/body")"
[[ "$(jq -r '.result.content[0].text | fromjson | .instance' "${case_dir}/body")" == "A" ]] \
  || fail "实例重启后未路由到 A 的实例"
if tail -n 5 "${case_dir}/stub.log" | grep -q "stub_rejected"; then fail "实例重启后拒绝了配对凭据"; fi
pass "实例重启：配对凭据落盘仍在，商家无需重新配对"

kill "${gateway_pid}" 2>/dev/null || true
wait "${gateway_pid}" 2>/dev/null || true
sleep 1
# 7×24 独立性：网关（以及 Buddy）不在时，商家实例仍对外服务（A2A 接待与
# MCP 管理都不依赖 Buddy 窗口）。这里以实例 MCP 直连验证「服务器独立运行」。
direct=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${instance_port}/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "Authorization: Bearer ${instance_token}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null || echo 000)
[[ "${direct}" == "200" ]] || fail "网关停止时实例应仍可服务（实得 ${direct}）"
pass "7×24 独立性：网关停止期间商家实例仍对外服务"
start_gateway
wait_health "${gateway_url}/health" "gateway（重启后）"
status=$(mcp_call "${token_a}" tools/list)
[[ "${status}" == "200" ]] || fail "网关重启后 tools/list: HTTP ${status} $(body)"
tools_after_restart=$(jq -r '.result.tools[].name' "${case_dir}/body" | tr '\n' ' ')
grep -q "kiwi_merchant_list_products" <<<"${tools_after_restart}" || fail "网关重启后缺实例工具"
grep -q "kiwi_catalog_save_publication_draft" <<<"${tools_after_restart}" || fail "网关重启后缺目录工具"
status=$(mcp_call "${token_a}" tools/call '{"name":"kiwi_catalog_get_merchant_profile","arguments":{}}')
[[ "${status}" == "200" ]] || fail "网关重启后目录调用: HTTP ${status} $(body)"
[[ "$(jq -r '.result.content[0].text | fromjson | .connected' "${case_dir}/body")" == "true" ]] \
  || fail "网关重启后目录凭据不可用（应加密落盘）"
pass "网关重启：OAuth 令牌、加密凭据与实例注册均落盘，商家无需重新连接"

# ── 12. A/B 两实例隔离：各自配对、各自路由、互不可达 ──────────────────────
gw_cookie_b="$(cat "${case_dir}/gw_cookie_b")"
token_b="$(cat "${case_dir}/token_b")"

KIWI_MERCHANT_MCP_TOKEN="${instance_token}" node "${kiwi_repo}/dist/cli.js" merchant mcp pair \
  --profile "${kiwi_repo}/examples/profiles/merchant.fake.yaml" \
  --data-dir "${case_dir}/instance-pairing-b" >"${case_dir}/pair-b.out" 2>&1
pair_code_b=$(sed -n 's/.*配对码：[[:space:]]*\([A-Z0-9-]*\).*/\1/p' "${case_dir}/pair-b.out" | head -1)
[[ -n "${pair_code_b}" ]] || fail "B 未取得配对码：$(cat "${case_dir}/pair-b.out")"
status=$(http_form "${gateway_url}/instance/pair" \
  "mcp_url=http://127.0.0.1:${instance_port_b}/mcp&code=${pair_code_b}" "${gw_cookie_b}")
[[ "$(header_location)" == "/instance?status=paired" ]] || fail "B 配对绑定未成功：$(header_location) $(body)"

b_tool_calls_before=$(grep -c '"label":"B".*"method":"tools/call"' "${case_dir}/stub.log" || true)
status=$(mcp_call "${token_b}" tools/call '{"name":"kiwi_merchant_list_products","arguments":{}}')
[[ "${status}" == "200" ]] || fail "B 实例工具调用: HTTP ${status} $(body)"
[[ "$(jq -r '.result.content[0].text | fromjson | .instance' "${case_dir}/body")" == "B" ]] \
  || fail "B 的调用未路由到 B 的实例"
b_tool_calls_after_b=$(grep -c '"label":"B".*"method":"tools/call"' "${case_dir}/stub.log" || true)
[[ "${b_tool_calls_after_b}" -gt "${b_tool_calls_before}" ]] || fail "B 的调用未打到 B 的实例"

status=$(mcp_call "${token_a}" tools/call '{"name":"kiwi_merchant_list_products","arguments":{}}')
[[ "${status}" == "200" ]] || fail "A 实例工具调用: HTTP ${status} $(body)"
[[ "$(jq -r '.result.content[0].text | fromjson | .instance' "${case_dir}/body")" == "A" ]] \
  || fail "A 的调用未路由到 A 的实例"
b_tool_calls_after_a=$(grep -c '"label":"B".*"method":"tools/call"' "${case_dir}/stub.log" || true)
[[ "${b_tool_calls_after_a}" == "${b_tool_calls_after_b}" ]] || fail "A 的调用打到了 B 的实例（隔离被破坏）"
# 两个实例各自都用**配对凭据**接受调用（凭据由各自实例签发，互不通用）。
paired_calls=$(grep -c '"kind":"paired"' "${case_dir}/stub.log" || true)
[[ "${paired_calls}" -ge 4 ]] || fail "两个实例的配对凭据调用数异常（实得 ${paired_calls}）"
pass "A/B 两实例隔离：各自配对、各自路由，A 的调用不达 B"

printf '\n验收通过（loopback 开发形态；生产联调仍需外部核验）：\n'
note "商家 A=${merchant_a}（粘贴绑定 → 解绑 → 配对码绑定 → 实例/网关重启演练）"
note "商家 B=${merchant_b}（先未绑定验证降级 → 后用配对码绑定其独立实例）"
note "公开资料 publication_id=${published_id}（商家在门户确认后才公开）"
note "证据目录：${case_dir}（退出时清理；catalog/gateway/stub 日志在其中）"
