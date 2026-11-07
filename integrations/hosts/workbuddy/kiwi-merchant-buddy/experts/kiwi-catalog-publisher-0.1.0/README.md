# Kiwi 商品发布

对商家提供的拟发布商品目录做发布前预检：必填字段、价格、库存、交易平台与平台商品 ID，并提示整表替换影响。

## 能力边界

- **只做预检**：输出逐行问题表、阻断/警告汇总和“是否具备进入人工预览条件”的结论。
- **不导入、不上传、不写回、不发布**：商品导入与发布由商家本人在 Kiwi 工作台「商品与导入」页完成。
- 不替商家做列映射、不生成导入文件、不修改原表。
- 不从标题或说明推断币种、单位、库存、SKU、有效期或平台 ID；缺失标缺失，冲突列冲突。
- 每次提醒整表替换语义：表里没有的仍在售 SKU 提交后会被下架。
- 不收集密码、验证码、配对码、密钥或 token。

## 包内容

```text
kiwi-catalog-publisher-0.1.0/
├── .codebuddy-plugin/plugin.json
├── agents/kiwi-catalog-publisher.md
├── skills/merchant-catalog-preflight/SKILL.md
└── avatars/kiwi.png
```

- 专家名称：Kiwi 商品发布 / Kiwi Product Publishing
- 预加载技能：`merchant-catalog-preflight`（Kiwi 商品目录发布预检）
- 连接器依赖：`kiwi-merchant`
- 版本：0.1.0

## 使用

在 WorkBuddy 专家/插件导入入口上传本目录（或对应 zip），选择 `kiwi-merchant` 连接器后启用。该包只做预检，不包含任何导入或发布工具。
