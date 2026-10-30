# 后端审批结果与上层处理

连接器只透传工具与结果，不生成 `approval_id`、批准/拒绝 action，也不验证真人身份。Kiwi
后端决定返回 `approval_required`、`authorization_denied`、`approval_denied` 或成功结果；应把
后端返回原样交给上层专家处理。

当上层专家依据当前任务授权决定调用 `kiwi_accept_agreement` 或 `kiwi_handoff`，如后端返回
`approval_required`，读取并呈现其中的审批标识和条款摘要。上层专家依据用户决策决定下一步；
若明确决定批准，再主动调用 `kiwi_approve` 并根据后端返回继续。连接器不会自动补调
`kiwi_approve` 或重试原 action。

条款、报价、商家或 action 改变时，应按 Kiwi 后端要求重新取得对应状态；不得把旧
`approval_id` 擅自用于不同 action。对于拒绝、等待或修改决定，由上层专家选择 `kiwi_reject`
或返回磋商；连接器不替其作决定。
