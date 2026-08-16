#!/usr/bin/env bash
# Kiwi B2B 试点供应侧种子（战略 v2.5 §3.4 / Phase 2 Supply 轨）。
#
# 自建 5 家"真实数据"商家（标准化办公/IT 配件）：
#   - 真实商品/库存/交付数据（scripts/pilot/data/office-it-products.csv）
#   - 真实城市/服务区/配送规则/运营标签
# 拒绝纯 mock：商品、库存、交付、政策都落在 shopping-cli SQLite，供 marketplace
# 市场 + merchant agent 消费，是后续 RFQ fan-out 的真实数据源。
#
# 用法：
#   SHOPPING_CLI_SRC=<repo> DB=<path> bash scripts/pilot/seed-merchants.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIWI_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SHOPPING_CLI_SRC="${SHOPPING_CLI_SRC:-$(cd "${KIWI_ROOT}/.." && pwd)/shopping-cli}"
DB="${DB:-${KIWI_ROOT}/.kiwi/pilot/marketplace.sqlite}"
CSV_DIR="${KIWI_ROOT}/scripts/pilot/data/merchants"

PY="${SHOPPING_CLI_SRC}/.venv/bin/python"
[[ -x "${PY}" ]] || { echo "shopping-cli venv not found (${PY})"; exit 1; }
[[ -d "${CSV_DIR}" ]] || { echo "merchant csv dir not found (${CSV_DIR})"; exit 1; }

mkdir -p "$(dirname "${DB}")"
chmod 700 "$(dirname "${DB}")"

# 5 家真实定位的办公/IT 商家（企业行政/IT/采购场景）。捕获 CLI 签发的 merchant_token
# 到 0600 env 文件（api_tokens 表只存哈希，真实 token 仅此时可见）。
TOKEN_FILE="$(dirname "${DB}")/merchant-tokens.env"
: > "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}"

seed_one() {
  local id="$1" name="$2" city="$3" area="$4" contact="$5" tags="$6" fee="$7" eta="$8" radius="$9"
  local out
  out=$("${PY}" scripts/shopping.py --db "${DB}" merchant create --id "${id}" --name "${name}" --city "${city}" --service-area "${area}" --contact "${contact}" --delivery-fee "${fee}" --delivery-eta-minutes "${eta}" --delivery-radius-km "${radius}" --tags "${tags}" --format json)
  local token
  token=$(echo "${out}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('merchant_token',''))")
  if [[ -n "${token}" ]]; then
    echo "${id}=${token}" >> "${TOKEN_FILE}"
  else
    echo "WARNING: no merchant_token for ${id}" >&2
  fi
}

seed_one merchant-hz-xihu "杭州西湖数码" 杭州 "西湖区,拱墅区" "wechat:hzxh-digital" "office-it,数码,企业采购" 8 45 15
seed_one merchant-sh-pudong "上海浦东办公耗材" 上海 "浦东新区,黄浦区" "wechat:shpd-office" "办公耗材,硒鼓,纸品,企业" 10 60 20
seed_one merchant-bj-zhongguancun "北京中关村 IT 配件" 北京 "海淀区,朝阳区" "wechat:bj-zgc-it" "IT 配件,扩展坞,线缆,企业" 12 50 25
seed_one merchant-gz-tianhe "广州天河电子商城" 广州 "天河区,越秀区" "wechat:gzth-elec" "电子产品,显示器,键鼠,企业采购" 8 40 18
seed_one merchant-sz-nanshan "深圳南山办公设备" 深圳 "南山区,福田区" "wechat:szns-office" "办公设备,监控,音频,企业" 8 35 15

# 真实商品/库存数据导入（每商家专属 CSV → SQLite，FK 归属商家；SKU 全局唯一）。
for m in merchant-hz-xihu merchant-sh-pudong merchant-bj-zhongguancun merchant-gz-tianhe merchant-sz-nanshan; do
  local_csv="${CSV_DIR}/${m}.csv"
  [[ -f "${local_csv}" ]] || { echo "missing csv for ${m}: ${local_csv}"; exit 1; }
  "${PY}" scripts/shopping.py --db "${DB}" import-csv-excel --file "${local_csv}" --merchant "${m}" --format json >/dev/null
done

TOTAL_PRODUCTS=0
for f in "${CSV_DIR}"/*.csv; do TOTAL_PRODUCTS=$((TOTAL_PRODUCTS + $(($(wc -l < "${f}") - 1)))); done
echo "seeded 5 merchants + ${TOTAL_PRODUCTS} product rows (real office/IT data) into ${DB}"
"${PY}" scripts/shopping.py --db "${DB}" merchant list --format json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); [print('  -', m['id'], m['name'], m.get('city')) for m in (d.get('results') or d if isinstance(d, list) else d.get('results', []))]" || true
