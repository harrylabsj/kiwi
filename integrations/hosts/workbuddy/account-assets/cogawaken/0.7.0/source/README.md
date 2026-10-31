# cogawaken

**海纳·认知专家 · 认知觉醒教练**

WorkBuddy 基础专家包：分析具体困境，一轮一个关键问题，区分观察与解释，形成小实验并复盘。无需认知专家中心、MCP 或额外模型 API Key。基础模型由 WorkBuddy 当前配置提供。

## 项目与看板

- [开发看板](BOARD.md)
- [产品设计](docs/product-blueprint.md)
- [安装与试用](docs/install.md)
- [验证记录](docs/verification.md)
- [行为评测案例](evaluations/scenarios.json)
- [0.2.0 五项优化](docs/v0.2-changes.md)
- [多轮评测与对照说明](evaluations/README.md)

## 构建和测试

开发与脚本运行环境：macOS / Linux，Python 3.9+。构建和记录工具仅依赖标准库；重新绘制头像才需要 Pillow，PNG 已随仓库提供。

```sh
python3 -m unittest discover -s tests -v
python3 scripts/package.py --check
python3 scripts/package.py
python3 scripts/board.py
python3 scripts/install_workbuddy.py
```

当前产物为 `dist/cogawaken-0.7.0.zip` 和 SHA-256 校验文件。默认使用十个入口，保留三十张方法。ZIP 只包含运行文件，不打包设计资料、测试、用户记录或缓存。

安装预览确认无误后执行 `python3 scripts/install_workbuddy.py --install`，使用本机 WorkBuddy 官方脚本注册本地专家。已存在同名安装时会停止，不覆盖。本机首次安装已完成，实机试聊状态见验证记录。

已有版本更新时，先运行预览取得 `installed_sha256`，核对安装副本没有个人修改，再执行 `python3 scripts/install_workbuddy.py --install --update --expected-installed-sha256 校验值`。旧包会备份；校验值不匹配时停止，不覆盖其他专家。

0.2.0 使用可重放的逐轮状态，八张方法卡带纠正、未知、停止和结果分支。`python3 scripts/demo_trace.py` 展示固定虚构对话通过实际检查器后的状态变化；它不调用模型。新增评测工具不会把缺失人工评审当成通过。

0.3.0 扩展到十六张方法卡，新增按 need／ID 读取、紧凑索引和来源署名。笔记改编统一署“海纳认知专家”，AI 补充设计单独标注，原著背景与改编部分分开。新增场景在 `evaluations/library-scenarios.json`，原有多轮场景继续保留。

0.6.0 新增五张判断与取舍方法卡，总计三十张，详见 [本批提取说明](docs/v0.6-changes.md)。

生成方法手册：`python3 scripts/render_method_guide.py --output /新的方法手册.md`。本轮修改与边界见 [0.3.0 说明](docs/v0.3-changes.md)。

## 布局

```text
workbuddy/cogawaken/       可独立分发的专家包
  .codebuddy-plugin/      WorkBuddy 配置
  agents/haina.md         海纳的核心行为
  skills/cogawaken-practice/
    references/           六张方法卡、依据与示例
    templates/            思考过程、记录、升级摘要
    scripts/              离线记录工具
scripts/                  验证、打包、看板生成
tests/                    数据与打包测试
evaluations/              真实行为测试输入与记录
.scratch/basic-edition/   需求与任务状态，生成看板的来源
```

## 数据与范围

默认不保存用户资料。明确要求保存后，仅操作用户指定目录。没有网络、遥测、自动扫描或自动提醒。记录可修正、导出和删除；删除记录文件不删除用户自己保留的输入稿或导出副本。

基础版只生成本地云端交接摘要，不提供真实云端服务或支付。WorkBuddy 可能使用外部模型，因此不承诺完全离线或免除平台费用。产品不是诊疗服务。

作者：海纳。联系邮箱：1711496337@qq.com。当前推进 WorkBuddy 基础版发布，提交、审核和上架状态以 docs/release-status.md 为准；未指定开源许可。
