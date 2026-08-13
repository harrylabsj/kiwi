"""KNP/1.0 envelope 构造 / digest / 校验（零 kiwi 依赖）。

镜像 Kiwi TS `src/negotiation/domain/envelope.ts` 的语义：

- envelope 必填字段：capability / protocol_version / negotiation_id /
  exchange_id / message_id / actor / action / created_at / payload / digest；
- digest = ``sha256:<hex(JCS(envelope 去掉 digest + transport signature 字段))>``
  （KNP §19.2）；
- ``terms_digest`` = ``content_digest(求值后的 agreed terms)``（§19.3），买卖双方
  各自计算必须一致。

结构校验 fail-closed：无法证明合法即为非法（未知 action / actor / 必填缺失 /
digest 不匹配一律拒绝）。
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from .jcs import content_digest

CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation"
PROTOCOL_VERSION = "1.0"

ACTORS = frozenset({"buyer", "merchant"})
ACTIONS = frozenset(
    {
        "inquiry",
        "rfq",
        "offer",
        "counter_offer",
        "conditional_offer",
        "clarification",
        "clarification_response",
        "accept_nonbinding",
        "withdraw",
        "decline",
        "cancel",
    }
)

# digest 计算时排除的 transport signature 字段（KNP §19.2，与 TS 一致）。
_SIGNATURE_FIELDS = frozenset(
    {"signature", "transport_signature", "http_message_signature", "x_message_signature"}
)

_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class EnvelopeError(ValueError):
    """envelope 结构 / digest 校验失败（fail-closed）。"""


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def new_negotiation_id() -> str:
    return _id("neg")


def new_exchange_id() -> str:
    return _id("ex")


def new_message_id() -> str:
    return _id("msg")


def new_offer_id() -> str:
    return _id("off")


def new_agreement_id() -> str:
    return _id("agr")


def _clean_for_digest(envelope: dict) -> dict:
    """克隆并去掉 digest 自身与 transport signature 字段（§19.2）。"""
    return {k: v for k, v in envelope.items() if k not in _SIGNATURE_FIELDS and k != "digest"}


def compute_envelope_digest(fields: dict) -> str:
    return content_digest(_clean_for_digest(fields))


def finalize_envelope(fields: dict) -> dict:
    """对未带 digest 的字段计算 digest，返回完整 envelope。"""
    if "digest" in fields:
        raise EnvelopeError("finalize_envelope: input must not already carry digest")
    return {**fields, "digest": compute_envelope_digest(fields)}


def verify_envelope_digest(envelope: dict) -> bool:
    return compute_envelope_digest(envelope) == envelope.get("digest")


def _require_str(value: Any, path: str) -> str:
    if not isinstance(value, str) or value == "":
        raise EnvelopeError(f"{path} must be a non-empty string")
    return value


def validate_envelope(value: Any) -> dict:
    """结构校验（fail-closed）。返回原 envelope（已校验 digest）。"""
    if not isinstance(value, dict):
        raise EnvelopeError("envelope must be an object")
    if value.get("capability") != CAPABILITY:
        raise EnvelopeError("capability mismatch")
    if value.get("protocol_version") != PROTOCOL_VERSION:
        raise EnvelopeError("protocol_version unsupported")
    for field in ("negotiation_id", "exchange_id", "message_id", "created_at"):
        _require_str(value.get(field), f"/{field}")
    actor = value.get("actor")
    if actor not in ACTORS:
        raise EnvelopeError(f"actor must be one of {sorted(ACTORS)}")
    action = value.get("action")
    if action not in ACTIONS:
        raise EnvelopeError(f"action must be one of {sorted(ACTIONS)}")
    if not isinstance(value.get("payload"), dict):
        raise EnvelopeError("/payload must be an object")
    digest = value.get("digest")
    if not isinstance(digest, str) or _DIGEST_RE.match(digest) is None:
        raise EnvelopeError("/digest must match ^sha256:[0-9a-f]{64}$")
    if not verify_envelope_digest(value):
        raise EnvelopeError("envelope digest does not match content")
    return value


# ---------------------------------------------------------------------------
# 买家动作构造器
# ---------------------------------------------------------------------------


def build_rfq(
    *,
    negotiation_id: str,
    sku: str,
    quantity: int,
    delivery_before: str,
    exchange_id: str | None = None,
    message_id: str | None = None,
    in_reply_to: str | None = None,
    created_at: str,
    actor: str = "buyer",
) -> dict:
    """RFQ envelope（§10）：items + 可选 requested_terms.delivery_before。"""
    fields = {
        "capability": CAPABILITY,
        "protocol_version": PROTOCOL_VERSION,
        "negotiation_id": negotiation_id,
        "exchange_id": exchange_id or new_exchange_id(),
        "message_id": message_id or new_message_id(),
        "actor": actor,
        "action": "rfq",
        "created_at": created_at,
        "payload": {
            "type": "rfq",
            "items": [{"sku": sku, "quantity": {"value": quantity, "unit": "piece"}}],
            "requested_terms": {"delivery_before": delivery_before},
        },
    }
    if in_reply_to is not None:
        fields["in_reply_to"] = in_reply_to
    return finalize_envelope(fields)


def build_counter_offer(
    *,
    negotiation_id: str,
    responding_to_offer_id: str,
    sku: str,
    quantity: int,
    amount_minor: int,
    currency: str = "CNY",
    exchange_id: str | None = None,
    message_id: str | None = None,
    in_reply_to: str,
    created_at: str,
    public_message: str | None = None,
) -> dict:
    """CounterOffer envelope（§12）：完整 proposed_terms（非 patch）。"""
    fields = {
        "capability": CAPABILITY,
        "protocol_version": PROTOCOL_VERSION,
        "negotiation_id": negotiation_id,
        "exchange_id": exchange_id or new_exchange_id(),
        "message_id": message_id or new_message_id(),
        "in_reply_to": in_reply_to,
        "actor": "buyer",
        "action": "counter_offer",
        "created_at": created_at,
        "payload": {
            "type": "counter_offer",
            "offer_id": new_offer_id(),
            "responding_to_offer_id": responding_to_offer_id,
            "proposed_terms": {
                "items": [
                    {
                        "sku": sku,
                        "quantity": {"value": quantity, "unit": "piece"},
                        "unit_price": {"currency": currency, "amount_minor": amount_minor},
                    }
                ]
            },
        },
    }
    if public_message is not None:
        fields["public_message"] = public_message
    return finalize_envelope(fields)


def build_accept_nonbinding(
    *,
    negotiation_id: str,
    accepted_offer_id: str,
    agreed_terms: dict,
    exchange_id: str | None = None,
    message_id: str | None = None,
    in_reply_to: str,
    created_at: str,
) -> dict:
    """AcceptNonbinding envelope（§15）：terms_digest = contentDigest(求值后 terms)。"""
    fields = {
        "capability": CAPABILITY,
        "protocol_version": PROTOCOL_VERSION,
        "negotiation_id": negotiation_id,
        "exchange_id": exchange_id or new_exchange_id(),
        "message_id": message_id or new_message_id(),
        "in_reply_to": in_reply_to,
        "actor": "buyer",
        "action": "accept_nonbinding",
        "created_at": created_at,
        "payload": {
            "type": "accept_nonbinding",
            "offer_id": accepted_offer_id,
            "terms_digest": content_digest(agreed_terms),
        },
    }
    return finalize_envelope(fields)


# ---------------------------------------------------------------------------
# 商家动作构造器
# ---------------------------------------------------------------------------


def offer_terms(
    *,
    sku: str,
    quantity: int,
    amount_minor: int,
    currency: str = "CNY",
    delivery_before: str,
    valid_until: str,
    handoff_destination: str | None = None,
) -> dict:
    """Offer terms（§11）：items 必带 unit_price + fulfillment_terms + valid_until。"""
    terms = {
        "items": [
            {
                "sku": sku,
                "quantity": {"value": quantity, "unit": "piece"},
                "unit_price": {"currency": currency, "amount_minor": amount_minor},
            }
        ],
        "fulfillment_terms": {"delivery_before": delivery_before},
        "valid_until": valid_until,
    }
    if handoff_destination is not None:
        terms["handoff_destination"] = handoff_destination
    return terms


def build_offer(
    *,
    negotiation_id: str,
    in_reply_to: str,
    terms: dict,
    exchange_id: str | None = None,
    message_id: str | None = None,
    created_at: str,
) -> dict:
    """Offer envelope（§11）：RFQ 的回复。"""
    fields = {
        "capability": CAPABILITY,
        "protocol_version": PROTOCOL_VERSION,
        "negotiation_id": negotiation_id,
        "exchange_id": exchange_id or new_exchange_id(),
        "message_id": message_id or new_message_id(),
        "in_reply_to": in_reply_to,
        "actor": "merchant",
        "action": "offer",
        "created_at": created_at,
        "payload": {"type": "offer", "offer_id": new_offer_id(), "terms": terms},
    }
    return finalize_envelope(fields)


def build_conditional_offer(
    *,
    negotiation_id: str,
    in_reply_to: str,
    responding_to_offer_id: str,
    base_terms: dict,
    then_terms: dict,
    quantity_threshold: int = 100,
    exchange_id: str | None = None,
    message_id: str | None = None,
    created_at: str,
) -> dict:
    """ConditionalOffer envelope（§13）：批量条件（aggregate.total_quantity gte 阈值）。"""
    fields = {
        "capability": CAPABILITY,
        "protocol_version": PROTOCOL_VERSION,
        "negotiation_id": negotiation_id,
        "exchange_id": exchange_id or new_exchange_id(),
        "message_id": message_id or new_message_id(),
        "in_reply_to": in_reply_to,
        "actor": "merchant",
        "action": "conditional_offer",
        "created_at": created_at,
        "payload": {
            "type": "conditional_offer",
            "offer_id": new_offer_id(),
            "responding_to_offer_id": responding_to_offer_id,
            "base_terms": base_terms,
            "conditions": [
                {
                    "when": {"all": [{"field": "aggregate.total_quantity", "op": "gte", "value": quantity_threshold}]},
                    "then_terms": then_terms,
                }
            ],
        },
    }
    return finalize_envelope(fields)


def build_agreement(
    *,
    negotiation_id: str,
    accepted_offer_id: str,
    agreed_terms: dict,
    created_at: str,
) -> dict:
    """AcceptedNonbindingAgreement artifact（三副作用恒 false）。"""
    return {
        "type": "accepted_nonbinding_agreement",
        "agreement_id": new_agreement_id(),
        "negotiation_id": negotiation_id,
        "accepted_offer_id": accepted_offer_id,
        "agreed_terms": agreed_terms,
        "terms_digest": content_digest(agreed_terms),
        "accepted_by": ["buyer", "merchant"],
        "created_at": created_at,
        "binding_effect": "nonbinding",
        "creates_order": False,
        "reserves_inventory": False,
        "authorizes_payment": False,
    }
