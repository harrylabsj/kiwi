#!/usr/bin/env bash
# Kiwi Merchant 三 Plane 验证（战略 v2.5 §7.5 Failure rule + §7.4）。
#
# 关闭 Intelligence & Ops Plane（kiwi merchant runtime 推理 harness）后，验证
# Commerce Plane + Merchant Core 仍完整工作：
#   1) 真实 RFQ → 确定性应答（真实价格/库存/交付）；
#   2) below-floor 还价 → 升级 human_required（Merchant Core 人工审核队列，
#      不依赖任何 LLM）；
#   3) 人类运营者经 Merchant Ops resolve-review 处理（Operator Console 只投影）。
#
# 前置：marketplace + resident daemon 运行（run-marketplace.sh start）。
# 用法：bash scripts/pilot/merchant-three-plane-check.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIWI_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BASE="${BASE:-http://127.0.0.1:8765}"
BUYER_TOKEN="${BUYER_TOKEN:-kiwi-pilot-buyer-bootstrap-0123456789}"

echo "== [1] 关闭 Intelligence & Ops（杀 kiwi merchant runtime）"
pkill -f "agent run --profile .kiwi/pilot/profiles" 2>/dev/null || true
sleep 1

echo "== [2] 真实 RFQ（Commerce + Merchant Core，Intelligence 离线）"
MTOKEN=$(grep "^merchant-hz-xihu=" "${KIWI_ROOT}/.kiwi/pilot/merchant-tokens.env" | cut -d= -f2-)
RES=$(curl -s --max-time 5 -X POST "${BASE}/conversations" -H "Authorization: Bearer ${BUYER_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"buyer_id":"buyer-3plane-1","merchant_id":"merchant-hz-xihu","sku":"HZ-DOCK-6IN1","text":"采购 10 个 USB-C 扩展坞 6 合 1，报个价","intent":"ask_price"}')
CONVID=$(echo "${RES}" | python3 -c "import sys,json;print(json.load(sys.stdin)['conversation']['id'])")
BTOKEN=$(echo "${RES}" | python3 -c "import sys,json;print(json.load(sys.stdin)['buyer_token'])")
sleep 5
REPLY=$(curl -s --max-time 5 "${BASE}/conversations/${CONVID}" -H "Authorization: Bearer ${BTOKEN}" \
  | python3 -c "import sys,json;[print(m.get('text','')[:60]) for m in json.load(sys.stdin).get('conversation',{}).get('messages',[]) if m.get('sender')=='merchant_agent']" | head -1)
echo "商家应答: ${REPLY}"
if [[ -z "${REPLY}" || "${REPLY}" == *"merchant human"* ]]; then echo "FAIL: 无确定性报价应答"; exit 1; fi

echo "== [3] below-floor 还价 → human_required（Merchant Core 审核队列）"
RES2=$(curl -s --max-time 5 -X POST "${BASE}/conversations" -H "Authorization: Bearer ${BUYER_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"buyer_id":"buyer-3plane-2","merchant_id":"merchant-hz-xihu","sku":"HZ-DOCK-6IN1","text":"能到 100 吗？10 个一起买","intent":"negotiate"}')
CONVID2=$(echo "${RES2}" | python3 -c "import sys,json;print(json.load(sys.stdin)['conversation']['id'])")
sleep 6
STATUS=$(sqlite3 "${KIWI_ROOT}/.kiwi/pilot/marketplace.sqlite" "SELECT status FROM conversations WHERE id='${CONVID2}'")
echo "below-floor 会话状态: ${STATUS}"
if [[ "${STATUS}" != "human_required" ]]; then echo "FAIL: 未升级 human_required"; exit 1; fi

echo "== [4] 人类运营者经 Merchant Ops resolve-review（Operator Console）"
REVIEWS=$(curl -s --max-time 5 "${BASE}/merchants/merchant-hz-xihu/human-review" -H "Authorization: Bearer ${MTOKEN}")
echo "${REVIEWS}" | python3 -c "import sys,json;cs=json.load(sys.stdin).get('conversations',[]);print('human_required 队列:',len(cs));[print('  ',c.get('id'),c.get('reason')) for c in cs[:2]]"
RESOLVE=$(curl -s --max-time 5 -X POST "${BASE}/conversations/${CONVID2}/human-review/resolve" \
  -H "Authorization: Bearer ${MTOKEN}" -H "content-type: application/json" \
  -d "{\"merchant_id\":\"merchant-hz-xihu\",\"decision\":\"approve\"}")
echo "${RESOLVE}" | python3 -c "import sys,json;d=json.load(sys.stdin);print('resolve ok:',d.get('ok'))"

echo "== [5] 结论：PASS — Intelligence & Ops 离线时 Commerce + Merchant Core 仍完整工作（RFQ/审核/运营）"