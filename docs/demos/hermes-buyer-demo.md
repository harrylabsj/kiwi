# Hermes Buyer 公开演示

Updated: 2026-08-18  
Evidence level: first-party operational demo（不是第三方采用或多商家互操作证据）

这套演示让观众在 3 分钟内看到：用户继续在 Hermes 中说采购需求，Hermes 调用
Kiwi Buyer 完成商家发现、询价和报价读取；演示明确停在协议接受、handoff 和付款之前。

## 一次准备

```bash
npm install -g @harrylabsj/kiwi
kiwi setup-hermes
```

`kiwi setup-hermes` 会配置 `kiwi-buyer-mcp` 并安装 `kiwi-buyer` Skill。完成后重启
Hermes 或开启新会话。

## 一条命令演示

在 Kiwi 仓库中运行：

```bash
npm run demo:hermes-buyer
```

只查看演示提示词、不发起询价：

```bash
npm run demo:hermes-buyer -- --print
```

默认提示词：

> 请用 Kiwi 帮我采购 2 个保温杯，收货地杭州，先搜索商家、发起询价并比较结果。
> 只演示到报价比较阶段：不要接受任何协议，不要 handoff，不要下单或付款。请在
> 最后列出实际调用过的 Kiwi 工具和每一步结果。

## 现场讲解脚本

1. **需求入口不变**：用户仍然对 Hermes 说话，不需要进入新的采购应用。
2. **发现**：Hermes 调用 `kiwi_search`，Kiwi 从公开目录返回可直接询价的商家。
3. **询价**：Hermes 调用 `kiwi_request_quotes`，获得稳定 `task_id`；写操作使用幂等键。
4. **读取结果**：Hermes 调用 `kiwi_get_task`，展示报价、交期、状态与部分失败。
5. **边界**：本演示不调用 `kiwi_negotiate`、`kiwi_accept_agreement`、
   `kiwi_approve` 或 `kiwi_handoff`，不创建订单、不付款。

## 2026-08-18 实际复验

本机 Hermes 已启用 `kiwi-buyer-mcp` 和 `kiwi-buyer`。默认提示词实际运行结果：

- `kiwi_search("保温杯")`：发现公开商家 Veyquo；
- `kiwi_request_quotes(...)`：成功创建询价任务并收到 KNP/1.0 报价；
- `kiwi_get_task(task_id)`：任务 `succeeded`，无 partial failure；
- 演示按要求停止，未接受协议、未 handoff、未下单或付款；
- 当时目录只有 1 家匹配商家，因此这次复验是“发现 + 询价 + 报价读取”，不是
  多商家比价证据。

公开讲解时不要使用已过期报价或把这次第一方复验描述成第三方采用。实时运行结果
才是当次演示的权威输出。

## 演示成功判定

- Hermes 输出实际调用过的 Kiwi 工具，而不是只生成说明文字；
- 至少获得一个 `task_id`，且 `kiwi_get_task` 可恢复读取；
- 商家失败或目录只有一家时如实呈现，不补造报价；
- 协议接受、handoff 与付款均未发生；
- 对外截图移除本机路径、会话 ID、token、邮箱、地址和非公开采购条件。

## 失败时怎么说

| 现象 | 对外说明与处理 |
| --- | --- |
| 没有匹配商家 | 目录尚无该商品，不编造结果；换用“保温杯”短词或接入目标商家 |
| 只有一家报价 | 如实称为单商家询价，不称为比价 |
| 商家端点不可达 | 保留任务和失败原因，修复 endpoint 后重新询价 |
| 报价过期 | 重新发起询价，不复用旧价格 |

公开案例必须记录参与方、证据、指标、边界和商家授权。
