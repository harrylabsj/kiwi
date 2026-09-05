# WorkBuddy integrations

Kiwi 首阶段以 Buyer Connector 接入 WorkBuddy；商家运行时继续独立部署。

- [`kiwi-sourcing/`](kiwi-sourcing/)：本地 stdio MCP + Skill 的「Kiwi 采购询价」连接器。

WorkBuddy 是用户交互与采购编排入口，Kiwi Buyer Core 负责采购状态和审批，独立的 Kiwi
Merchant Agent 继续持有商家私有商品、库存、报价策略、凭证和 Ledger。后续如建设商家经营
Buddy 应用，它也只能作为独立 Merchant Agent 的运营控制面，不替代商家运行时。
