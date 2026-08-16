#!/usr/bin/env bash
# Kiwi B2B 试点市场运行时（战略 v2.5 Phase 2 Supply 轨）。
#
# 启动 shopping-cli marketplace API + 5 家种子商家 agent daemon（真实商品/库存/
# 交付数据），供 kiwi-buyer-mcp 的 QuoteFetcher 真实 fan-out。
#
# 前置：先跑 scripts/pilot/seed-merchants.sh 生成 marketplace.sqlite。
#
# 用法：
#   bash scripts/pilot/run-marketplace.sh [start|stop|status]
#   PORT=8765 SHOPPING_CLI_SRC=<repo> DB=<path> bash scripts/pilot/run-marketplace.sh start
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIWI_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SHOPPING_CLI_SRC="${SHOPPING_CLI_SRC:-$(cd "${KIWI_ROOT}/.." && pwd)/shopping-cli}"
DB="${DB:-${KIWI_ROOT}/.kiwi/pilot/marketplace.sqlite}"
PORT="${PORT:-8765}"
BASE="http://127.0.0.1:${PORT}"
PID_DIR="${KIWI_ROOT}/.kiwi/pilot/run"
LOG_DIR="${KIWI_ROOT}/.kiwi/pilot/run"
mkdir -p "${PID_DIR}" "${LOG_DIR}"
chmod 700 "${PID_DIR}" "${LOG_DIR}"

PY="${SHOPPING_CLI_SRC}/.venv/bin/python"
[[ -x "${PY}" ]] || { echo "shopping-cli venv not found (${PY})"; exit 1; }
[[ -f "${DB}" ]] || { echo "pilot db not found (${DB}); run scripts/pilot/seed-merchants.sh first"; exit 1; }

# marketplace 需要的 auth env（本地开发 profile）。
export SHOPPING_DEPLOYMENT_PROFILE=local
export SHOPPING_ADMIN_TOKEN="${SHOPPING_ADMIN_TOKEN:-kiwi-pilot-admin-0123456789abcdef}"
export SHOPPING_BUYER_BOOTSTRAP_TOKEN="${SHOPPING_BUYER_BOOTSTRAP_TOKEN:-kiwi-pilot-buyer-bootstrap-0123456789}"

MERCHANTS=(merchant-hz-xihu merchant-sh-pudong merchant-bj-zhongguancun merchant-gz-tianhe merchant-sz-nanshan)

stop_all() {
  for p in "${PID_DIR}"/*.pid; do
    [[ -f "${p}" ]] || continue
    kill "$(cat "${p}")" 2>/dev/null || true
    rm -f "${p}"
  done
  echo "stopped marketplace + merchant agents"
}

status_all() {
  local running=0
  for p in "${PID_DIR}"/*.pid; do
    [[ -f "${p}" ]] || continue
    if kill -0 "$(cat "${p}")" 2>/dev/null; then running=$((running + 1)); fi
  done
  echo "running processes: ${running}"
  if curl -sf "${BASE}/health" >/dev/null 2>&1; then echo "marketplace API: healthy"; else echo "marketplace API: down"; fi
}

case "${1:-start}" in
  stop) stop_all; exit 0 ;;
  status) status_all; exit 0 ;;
  start) ;;
  *) echo "usage: $0 [start|stop|status]"; exit 2 ;;
esac

echo "== starting marketplace API on ${BASE} (db: ${DB})"
(cd "${SHOPPING_CLI_SRC}" && "${PY}" -m shopping_cli.api.server --db "${DB}" --host 127.0.0.1 --port "${PORT}" >"${LOG_DIR}/marketplace.log" 2>&1) &
echo $! > "${PID_DIR}/marketplace.pid"

for _ in $(seq 1 40); do
  curl -sf "${BASE}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "${BASE}/health" >/dev/null 2>&1 || { echo "marketplace failed to start"; tail -30 "${LOG_DIR}/marketplace.log"; exit 1; }
echo "marketplace API healthy"

# 商家 agent daemon：真实商品/库存/交付数据，确定性规则回复（无 LLM 依赖）。
# 长驻 agent 必须通过 SHOPPING_AGENT_TOKEN env 收 token（fail-closed）。
# token 来自 seed 捕获的 merchant-tokens.env（api_tokens 表只存哈希）。
TOKEN_FILE="$(dirname "${DB}")/merchant-tokens.env"
for m in "${MERCHANTS[@]}"; do
  token=""
  if [[ -f "${TOKEN_FILE}" ]]; then
    token=$(grep "^${m}=" "${TOKEN_FILE}" | head -1 | cut -d= -f2- || true)
  fi
  if [[ -z "${token}" ]]; then echo "no token for ${m}; re-run seed-merchants.sh"; continue; fi
  (
    cd "${SHOPPING_CLI_SRC}"
    # 长驻模式：token 只走 env（cli_agent_commands 显式禁止命令行 token）。
    export SHOPPING_AGENT_TOKEN="${token}"
    "${PY}" scripts/shopping.py agent run --merchant "${m}" --api-url "${BASE}" --interval 2
  ) >"${LOG_DIR}/${m}.log" 2>&1 &
  echo $! > "${PID_DIR}/${m}.pid"
done

sleep 2
echo "== merchant agents started (logs in ${LOG_DIR})"
curl -sf "${BASE}/capabilities" | python3 -c "import sys,json; d=json.load(sys.stdin); print('protocol_versions:', d['capabilities'].get('protocol_versions'))" 2>/dev/null || true
