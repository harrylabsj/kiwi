#!/usr/bin/env bash
# Kiwi B2B 试点商家目录注册（战略 v2.5 §3.2 / Phase 2）。
#
# 把 5 家试点商家（shopping-cli marketplace-backed）注册进 kiwi-catalog，
# 使 kiwi_search 能返回真实商家（Discovery & Routing Index；商品 truth 仍在
# merchant/marketplace，catalog 不拥有商品 truth）。merchant_id 与 marketplace
# 商家 id 一致，保证 kiwi_search 结果可直接作为 kiwi_request_quotes 的 merchant_ids。
#
# 前置：kiwi-catalog 已运行（:8000）+ 商家已 seed（scripts/pilot/seed-merchants.sh）。
# 用法：
#   CATALOG_URL=http://127.0.0.1:8000 CATALOG_ADMIN_TOKEN=<token> bash scripts/pilot/register-catalog.sh
set -euo pipefail

CATALOG_URL="${CATALOG_URL:-http://127.0.0.1:8000}"
CATALOG_ADMIN_TOKEN="${CATALOG_ADMIN_TOKEN:-kiwi-pilot-admin-0123456789abcdef}"

# 商家 → (domain, display_name)
# 域名用可解析方向的合成域名（catalog 只做 normalization + namespace 校验）。
MERCHANTS=(
  "merchant-hz-xihu|hz-xihu-digital.example.com|杭州西湖数码"
  "merchant-sh-pudong|sh-pudong-office.example.com|上海浦东办公耗材"
  "merchant-bj-zhongguancun|bj-zgc-it.example.com|北京中关村 IT 配件"
  "merchant-gz-tianhe|gz-tianhe-elec.example.com|广州天河电子商城"
  "merchant-sz-nanshan|sz-nanshan-office.example.com|深圳南山办公设备"
)

for entry in "${MERCHANTS[@]}"; do
  IFS='|' read -r mid domain name <<< "${entry}"
  payload=$(python3 -c "import json,sys;print(json.dumps({
    'domain': '$domain',
    'agent_card_url': 'https://$domain/.well-known/agent-card.json',
    'ucp_profile_url': 'https://$domain/.well-known/ucp',
    'merchant_id': '$mid',
    'display_name': '$name',
    'hosting_mode': 'hosted_only',
    'capabilities': ['com.harrylabsj.kiwi.shopping.negotiation'],
    'handoff_destination_types': ['external_checkout_url']
  }))")
  result=$(curl -s --max-time 8 -X POST "${CATALOG_URL}/v1/agent-catalog/agents/register" \
    -H "Authorization: Bearer ${CATALOG_ADMIN_TOKEN}" \
    -H "content-type: application/json" -d "${payload}")
  echo "${result}" | python3 -c "import sys,json; d=json.load(sys.stdin); a=d.get('catalog_agent',{}); print('  ', a.get('merchant',{}).get('id'), '->', a.get('catalog_agent_id'), '| ok:', d.get('ok'))"
done

echo "registered. verify via ${CATALOG_URL}/v1/agents:"
curl -s --max-time 5 "${CATALOG_URL}/v1/agents" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',[]); print('agents:', len(r)); [print('  -', a.get('merchant_id') or a.get('catalog_agent_id'), a.get('display_name'), a.get('verification',{}).get('status')) for a in r]"
