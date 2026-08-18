#!/usr/bin/env bash
set -euo pipefail

KIWI_HERMES_DEMO_QUERY="${KIWI_HERMES_DEMO_QUERY:-请用 Kiwi 帮我采购 2 个保温杯，收货地杭州，先搜索商家、发起询价并比较结果。只演示到报价比较阶段：不要接受任何协议，不要 handoff，不要下单或付款。请在最后列出实际调用过的 Kiwi 工具和每一步结果。}"

if [[ "${1:-}" == "--print" ]]; then
  printf '%s\n' "$KIWI_HERMES_DEMO_QUERY"
  exit 0
fi

if ! command -v hermes >/dev/null 2>&1; then
  printf '%s\n' "未检测到 Hermes。请先安装 Hermes，再运行 kiwi setup-hermes。" >&2
  exit 2
fi

printf '%s\n' "Hermes Buyer 演示：搜索 → 询价 → 报价比较（在协议、handoff 和付款前停止）"
exec hermes chat \
  -Q \
  --source kiwi-demo \
  --max-turns 30 \
  --skills kiwi-buyer \
  -q "$KIWI_HERMES_DEMO_QUERY"
