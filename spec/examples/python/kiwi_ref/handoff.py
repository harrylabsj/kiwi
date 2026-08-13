"""KTH HandoffCandidate（KTH/0.1 §5/§6）— 零 kiwi 依赖，纯标准库。

"触发 KTH Handoff（不真交易）" = 达成 non-binding Agreement 后，买家构造一个
**不可变 HandoffCandidate**（三副作用恒 false：``creates_order`` /
``authorizes_payment`` / ``reserves_inventory``），并把它作为
``handoff_candidate_created`` 事件写入可校验 transcript。**不** 发起任何真实
订单/支付/库存变更——候选只是成交入口（URL/会话/单据引用）的载体。

destination_type 词表（单一来源，镜像 TS `src/handoff/destination.ts` 的 11 值）：
ucp_checkout / ucp_order / external_checkout_url / merchant_checkout_session /
platform_deep_link / buyer_erp_request / procurement_request /
purchase_order_draft / quote_document / merchant_contact / sales_handoff。
"""

from __future__ import annotations

import uuid
from typing import Any

from .jcs import content_digest

DESTINATION_TYPES = frozenset(
    {
        "ucp_checkout",
        "ucp_order",
        "external_checkout_url",
        "merchant_checkout_session",
        "platform_deep_link",
        "buyer_erp_request",
        "procurement_request",
        "purchase_order_draft",
        "quote_document",
        "merchant_contact",
        "sales_handoff",
    }
)

_POLICY_VERSION = "handoff-policy/1"


class HandoffError(ValueError):
    """候选构造不合法（fail-closed）。"""


def new_handoff_candidate_id() -> str:
    return f"hcan_{uuid.uuid4().hex}"


def new_handoff_id() -> str:
    return f"hnd_{uuid.uuid4().hex}"


def build_handoff_candidate(
    *,
    agreement_id: str,
    negotiation_id: str,
    terms_digest: str,
    buyer_identity_ref: str,
    merchant_identity_ref: str,
    destination_type: str,
    destination_ref: str,
    created_at: str,
    expires_at: str,
    display_summary: dict[str, str] | None = None,
    destination_payload: dict | None = None,
    requires_user_action: bool = True,
) -> dict:
    """构造不可变 HandoffCandidate（三副作用恒 false + candidate_digest）。"""
    if destination_type not in DESTINATION_TYPES:
        raise HandoffError(f"destination_type must be one of {sorted(DESTINATION_TYPES)}")
    fields = {
        "handoff_candidate_id": new_handoff_candidate_id(),
        "supersedes_candidate_id": None,
        "agreement_id": agreement_id,
        "negotiation_id": negotiation_id,
        "terms_digest": terms_digest,
        "buyer_identity_ref": buyer_identity_ref,
        "merchant_identity_ref": merchant_identity_ref,
        "destination_type": destination_type,
        "destination_ref": destination_ref,
        "destination_payload": destination_payload or {},
        "display_summary": display_summary or {},
        "policy_version": _POLICY_VERSION,
        "expires_at": expires_at,
        "requires_user_action": requires_user_action,
        "creates_order": False,
        "authorizes_payment": False,
        "reserves_inventory": False,
        "created_at": created_at,
    }
    return {**fields, "candidate_digest": content_digest(fields)}


def verify_candidate_digest(candidate: dict) -> bool:
    clean = {k: v for k, v in candidate.items() if k != "candidate_digest"}
    return content_digest(clean) == candidate.get("candidate_digest")


def assert_no_side_effects(candidate: dict) -> None:
    """三副作用不变量：任一非 false → fail-closed。"""
    for field in ("creates_order", "authorizes_payment", "reserves_inventory"):
        if candidate.get(field) is not False:
            raise HandoffError(f"{field} must be false — candidate must not touch order/payment/inventory")


def handoff_candidate_created_event(
    *,
    candidate: dict,
    buyer_identity_ref: str,
    merchant_identity_ref: str,
    occurred_at: str,
    negotiation_id: str,
) -> dict:
    """把候选作为 ``handoff_candidate_created`` 事件内容返回（供 Transcript.append）。"""
    return {
        "event_kind": "handoff_candidate_created",
        "negotiation_id": negotiation_id,
        "handoff_candidate_id": candidate["handoff_candidate_id"],
        "agreement_id": candidate["agreement_id"],
        "terms_digest": candidate["terms_digest"],
        "destination": {
            "type": candidate["destination_type"],
            "ref": candidate["destination_ref"],
        },
        "identity": {
            "sender_identity": buyer_identity_ref,
            "counterparty_identity": merchant_identity_ref,
            "actor": "buyer",
        },
        "capability": {
            "capability": "com.harrylabsj.kiwi.shopping.negotiation",
            "protocol_version": "1.0",
        },
        "outcome": {"kind": "ok", "result": {"candidate": candidate}},
        "occurred_at": occurred_at,
    }
