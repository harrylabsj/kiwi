# 恢复、轮询与裸MCP合同

## 3-1：状态不是revision

NegotiationRecovery仍返回原 resumed/reconciliation_required、replayed及remote-ahead等计数。remote task.state只描述生命周期；working→completed不能证明旧报价revision变化。当前接口没有可核验远端revision，因此 resumed.reason 明示 staleness unknown，stale_message_ids为空；不表示已证明新鲜，也不把未知staleness无条件变成人工阻断。

已确认送达和本轮安全重放成功的消息都不能仅按state列stale。现expireStale可选类型为兼容保留并废弃调用语义；当前模块不调用它。业务方仍须对具体候选、授权/有效期和权威事实做原有检查，不可把空列表当批准放行。未来若需自动失效，先定义独立revision/候选绑定证据及授权合同，不能直接恢复state比较逻辑。本次不增加wire/schema或远端revision字段，不自动作废批准。33项的BuyerProtocolRecovery是独立模块，unknown barrier、receipt/raw绑定和持久TaskContext未被修改。

## 3-12：poll是独立观察回合

A2ATaskPoller每次poll新建tracker，校验该次调用内合法转换，按原attempt/deadline返回terminal/input-required/timeout等结果。同实例下一次poll不承诺记住上次terminal；跨回合phase/revision、旧批准与并发写由业务会话/权威状态维护。没有新跨task缓存，也没有自动清旧状态/批准。不要把“第二轮可观察working”表述成服务端已证明恢复合法；只是此轮没有上一轮历史。

## 3-40：监听与认证

startMerchantMcpServer在造handler/listen前复用auth policy：无auth的0.0.0.0（默认）/::/非loopback拒绝；显式本机127.0.0.1/::1及同一loopback的IPv4-mapped地址可用。有auth仍逐请求验Bearer，不新增OAuth。

裸createMerchantHttpHandler不拥有listen配置；对/mcp仅在无auth时额外核真实socket.localAddress。非loopback、wildcard或未知地址拒在MCP/工具效果前。Host、Origin、XFF都不是监听证据；模拟/组合适配器必须提供真实可信socket，不能填用户头。Node标准127.0.0.1、::1和IPv4-mapped 127.0.0.1受支持；localhost字符串不是socket地址。

socket检查是纵深，不是对外暴露授权：反向代理可能让本地backend socket看似loopback，必须在受信配置/listen层给非本地入口配置auth，不能借proxy绕过。生产assembly原auth policy继续为主门；/oauth、普通/admin自检等路由不被这个仅/mcp检查一概禁用。本机无auth仍意味着所有能连接该本机端口的主体均可信，若不成立应配auth。

合法IPv6字面量返回URL使用方括号；真实::1正控直接使用handle.url。此格式缺陷在基底已存在，本次仅收口这个合法入口，不改变默认wildcard或认证策略。
