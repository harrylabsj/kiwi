# Kiwi采购智能体

WorkBuddy 独立专家，面向公司采购。采购事项、比较快照和外部决定保存在本机独立命名空间。桌面端需要 macOS 或 Linux，以及 Node.js 22.19 或更新版本。每个操作系统账户对应一个买家。

## 构建与验收

从 Kiwi 仓库根目录安装锁定依赖后，执行以下两条命令。

```sh
node integrations/hosts/workbuddy/package-company-procurement-expert.mjs --check
node integrations/hosts/workbuddy/package-company-procurement-expert.mjs --out /absolute/path/kiwi-company-procurement-expert-1.0.2.zip
```

提交 WorkBuddy 的文件是生成的 ZIP。包内运行时由共享管线从当前 checkout 构建并锁定文件摘要。打包器会验证中英文工具契约和主体隔离，并从解压后的正式提交包验证冷启动保存需求、复用请求编号及离线报价比选。采购外发的临时授权需要客户端支持 MCP 表单确认。缺少该能力时仍可执行事项、参考来源记录和比选。旧购物专家继续使用原有 13 工具契约。旧入口遇到多候选澄清或还价时返回 TARGET_REQUIRED，同一家商家的单候选任务继续使用原调用方式。

## 参考商家配置

在商家侧将 `KIWI_MERCHANT_PROCUREMENT_FACTS` 设为由商家维护的 JSON 文件路径，再启动商家运行时。每个键为商家 SKU，示例如下。

```json
{
  "YOUR-SKU": {
    "version": "approved-terms-2026-11",
    "model": "DEMO-65W",
    "destination": "北京",
    "values": {
      "invoice": "增值税普通发票",
      "warranty": 36,
      "specifications": { "power-watts": 65 }
    },
    "native_basis": "net",
    "goods_tax_bps": 1300,
    "freight": { "included": false, "amount_minor": 12000, "tax": "gross" },
    "no_other_fees": true
  }
}
```

启用前按实际商品、销售单位、地区运费及商家审批后的条款填写。示例金额按分表示，税率按基点，保修按月。商品价及库存依然来自商家商品事实提供器，到货依据来自商家配置的交期。未提供的条款保持待核对，历史报价仍按版本保留。

## 电商材料

公开页面、用户给出的链接和摘录可由相应技能录入为参考来源。账户价格与店铺沟通能力以 WorkBuddy 实际提供的授权和工具为准。正式外部报价需要可信捕获流程。

已获授权的宿主适配器可在专家独立数据目录的 `captures/` 中写入 `capture_id.json`。目录权限为 0700，文件权限为 0600。捕获内容须由宿主验证适用账户、具体商品变体、原始材料及报价权威性。最小生产结构为 name、variant、price_kind、evidence、product 和 costs。evidence 包含材料引用、可定位位置和带时区的采集时间，正式报价还需要有效期。product 包含可核实的型号、主体引用、规格、库存和到货信息。经宿主核验同一企业主体后，product 可以记录 verified_kiwi_merchant_id，用于双渠道供货主体去重。costs 包含商品、分项税费及完整度。普通对话工具参数只登记参考来源。缺少授权来源时继续输出缺项及人工联系草稿。
