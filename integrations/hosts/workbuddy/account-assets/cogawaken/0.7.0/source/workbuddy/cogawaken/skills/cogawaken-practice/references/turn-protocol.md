# v2 逐轮检查协议

## 边界

这是本地工具协议，不是宿主拦截器。WorkBuddy 模型需要按指令调用并使用检查结果；未调用的回复不受程序检查。source_trust 始终为调用方提供的原话，不能当成由宿主认证的用户签名。校验值和事件重放用于检查一致性，不提供防篡改身份保证。

默认无文件写入。状态包含对话原话、模型提案、方法快照、工具回执与实际返回文字。调试记录只保存简短选择依据，不索取或保存隐藏思维链。无文件模式需要传回状态 JSON，长会话有上下文成本；用户愿意本地保存时，可用有版本控制的持久模式减少重复传输。

## 无文件模式

将 SKILL_DIR 替换为真实安装技能目录。

```sh
python3 SKILL_DIR/scripts/cogawaken.py session-new
python3 SKILL_DIR/scripts/cogawaken.py turn-check --input -
```

第二个命令从标准输入接受 `{ "state": 上一次返回的完整状态, "turn": 本轮提案 }`，返回 checked、新状态与 reply_text。会话状态不能直接修改，只能通过事件更新；修改后将因重放不一致被拒绝。源对话的真实性仍取决于调用方。

## 本轮提案

```json
{
  "turn_id": "u1",
  "user_text": "我想梳理周日没写文章这件事。",
  "plan": {
    "mode": "explore",
    "stage": "describe",
    "reason": "用户提出具体复盘目标，先询问事件经过。",
    "model": "unreported",
    "goal": {
      "text": "梳理周日没写文章",
      "source": {"turn_id": "u1", "quote": "梳理周日没写文章"}
    },
    "observations": [{"turn_id": "u1", "quote": "周日没写文章"}],
    "method": {"id": "observe-interpret", "branch": "entry"},
    "reply": {
      "reflection": "我们先看这一次的具体经过。",
      "question": "当时准备写的时候，发生了什么？",
      "advice": "",
      "summary": ""
    }
  }
}
```

mode 为 explore/advice/summary/stop。用户明确“直接给建议”“帮我整理”“停一下”等已知命令优先；其他自然表达仍需模型理解。reply 的四个字段都必须提供，按 reflection、advice、summary、question 顺序拼接。最多一个问号是机械检查，不能代替语义检查。

method 可以为 null，探索模式必须给出简短原因。所选卡和分支必须存在，并匹配阶段。分支的 next_stage 是建议而非强制下一步；模型结合用户更正与目标决定。

## 状态事件

events 为列表，每个事件带 hypothesis_id 与 source: {turn_id, quote}。原话必须逐字出现在对应用户发言中。

| type | 必要附加字段 | 程序更新 |
| --- | --- | --- |
| propose | text | 新假设；formulation=unconfirmed，evidence=untested |
| confirm_formulation | 无 | 只确认转述，证据保持原状态 |
| reject | 无 | 撤回假设，清除关联实验，不自动复活 |
| accept_experiment | 无 | 只确认愿意尝试，不记为实际结果 |
| evidence | direction=supports/challenges/inconclusive | 登记实验反馈，方向来源仍为模型判断；支持与挑战并存时 mixed |

核对时用 `ask_confirmation: {scope: "formulation", hypothesis_id: "h1"}`，且回复必须出现 h1 的确切文字与一个核对问题。确认只能来自紧接着的一轮明确简短肯定回答，例如“准确”。“准确，但是你后半句不对”不会被当成确认；继续按原话更正即可，不要求反复回答同一个问题。

实验确认用 scope=experiment，回复须展示具体 action。experiment 包含 hypothesis_id、action、observe、stop_condition、outcomes；outcomes 必须分别写 supports、challenges、inconclusive。假设表述先核对，再提出实验。进入 review 时需要已接受的实验及当前 evidence 事件。

未实施实验不能登记 evidence。把用户原话放进 observations，选择 feedback-loop 的 not-done 分支，调整安排或整理结束。“推迟／中断”与“假设被反驳”要分开。

## 保存到用户指定目录

```sh
python3 SKILL_DIR/scripts/cogawaken.py session-new --directory /用户选择的目录 --confirmed
python3 SKILL_DIR/scripts/cogawaken.py session-turn --directory /用户选择的目录 --id SESSION_ID --expected-revision 0 --input - --confirmed
python3 SKILL_DIR/scripts/cogawaken.py session-read --directory /用户选择的目录 --id SESSION_ID
python3 SKILL_DIR/scripts/cogawaken.py session-export --directory /用户选择的目录 --id SESSION_ID
python3 SKILL_DIR/scripts/cogawaken.py session-delete --directory /用户选择的目录 --id SESSION_ID --confirmed
```

session-turn 的输入只含本轮提案；前态由文件读取，不允许模型覆盖历史。第一次修订为 0→1，后续使用返回的 revision。写入加锁并原子替换；冲突时保留原文件。一个会话保存在 session-UUID.json，删除时一并删除原话、假设、追踪和方法快照，不保留隐藏历史副本；用户自存导出副本不在删除范围内。

needs_revision 表示提案没有通过，persisted=false，不会输出假装合格的回答。同一回合不要重复登记；已成功的请求重试应先读取确认。session-export 只输出 Markdown，不创建另一个副本。

## 可追溯性解释

每轮记录：用户原话、模型提案、简短依据、声明的模型名称、实际输出、程序检查项、所选方法和分支的版本／校验值、前一条记录校验值。模型名称缺失则为 unreported，不猜测。

method_receipt.origin 表示程序读取了会话内保存的方法快照；selection_origin 表示模型提出选择。它不证明模型按方法思考，也不证明适用性正确。semantic_verified 始终为 false。整体状态可从记录重放重建，从而发现直接改写确认状态等不一致。
