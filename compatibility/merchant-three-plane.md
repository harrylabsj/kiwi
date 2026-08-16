# Merchant 三 Plane 架构映射（战略 v2.5 §7.5）

Merchant 端三个逻辑 Plane，Failure rule：**Ops/Reasoning 失败不得阻止 Merchant
Core**。上两层（Intelligence & Ops）整体不可用，Commerce Plane + Merchant Core
仍必须保持业务可用。

## 映射（shopping-cli，截至 2026-08-16）

| Plane | 职责 | shopping-cli 模块 | 状态权威 |
|---|---|---|---|
| **Commerce Plane** | ERP/PIM/Inventory/Pricing；UCP Catalog/Checkout/Order | `shopping_cli/data_sources/`（csv_excel/erp/adapter）、`core/catalog*.py`、`core/delivery.py` | 是（商品/库存/交付 truth） |
| **Kiwi Merchant Core** | Identity、RFQ、KNP 状态机、Policy、Approval、Agreement、Audit、Recovery、Final Writes | `core/negotiation*.py`、`core/policies.py`、`core/conversations.py`、`core/risk.py`、`core/harness.py`（claims）、`api/handlers/negotiation.py`、`api/handlers/human_review.py` | **是（唯一权威）** |
| **Intelligence & Ops Plane** | Hermes/Console/Human 运营 + DeepSeek Harness 推理增强（只产 DecisionCandidate） | `agents/`（merchant_agent.py 等 resident 规则应答）、kiwi merchant runtime（磋商增强）、Merchant Ops（`kiwi.merchant.*`） | 否（只投影/提交候选/审批输入） |

## 独立性验证（§7.4 硬约束）

`scripts/pilot/merchant-independence.sh` + Merchant Ops 端点验证：
1. **关闭 Intelligence & Ops**（杀 kiwi merchant runtime 推理 harness；Hermes 非
   本进程依赖）后，Commerce + Merchant Core 仍：
   - 接收真实 RFQ 并确定性应答（真实价格/库存/交付）；
   - 将 below-floor / unclear-product 升级为 **human_required**（Merchant Core
     人工审核队列，不依赖任何 LLM）；
   - 暴露 merchant 运营端点（RFQ 队列 / human-review / analytics）。
2. 人类运营者经 Merchant Ops `resolve-review` 处理 human_required（Operator
   Console 只是输入面，审批记录在 Merchant Core）。

## 运行时隔离

- Marketplace（Commerce + Merchant Core）无任何 Host/LLM 依赖即可独立运行。
- kiwi merchant runtime（Intelligence）可插拔；其故障不阻断 RFQ 接收 / 确定性
  策略 / 人工审核队列 / 恢复（§7.4/§7.6）。
