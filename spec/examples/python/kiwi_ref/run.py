"""CLI：买家完整流程 / 商家服务 / transcript 校验。

用法：
    python -m kiwi_ref merchant --port 8123 [--sku SKU-001 --price 85000 --deal 83500]
    python -m kiwi_ref buyer --url http://127.0.0.1:8123 [--sku SKU-001 --quantity 200 --counter 83000 --jsonl out.jsonl]
    python -m kiwi_ref verify --jsonl out.jsonl

买家流程：读 Agent Card → RFQ → Offer → CounterOffer → ConditionalOffer →
求值 → Accept → Agreement → 构造 KTH HandoffCandidate → 写入可校验 transcript
（哈希链）。三副作用恒 false；不发起任何真实交易。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from datetime import datetime, timezone
from typing import Any

from . import envelope as env
from .a2a import A2AClient, decline_or_envelope, extract_agreement
from .conditional import evaluate_conditional
from .handoff import build_handoff_candidate, handoff_candidate_created_event
from .merchant import MerchantHTTPServer
from .transcript import Transcript

DEFAULT_SKU = "SKU-001"
DEFAULT_QUANTITY = 200
DEFAULT_COUNTER_PRICE = 83000
DEFAULT_DELIVERY_BEFORE = "2026-08-20T18:00:00Z"


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _expiry(now: str, hours: int = 24) -> str:
    from datetime import timedelta

    dt = datetime.fromisoformat(now.replace("Z", "+00:00"))
    return (dt + timedelta(hours=hours)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_buyer(
    *,
    url: str,
    sku: str = DEFAULT_SKU,
    quantity: int = DEFAULT_QUANTITY,
    counter_price: int = DEFAULT_COUNTER_PRICE,
    delivery_before: str = DEFAULT_DELIVERY_BEFORE,
    buyer_identity: str = "buyer:kiwi-ref-python",
    now: Any | None = None,
) -> dict:
    """完整买家流程，返回 {agreement, offer, conditional, transcript, candidate}。"""
    now_fn = now or _utc_now
    client = A2AClient(url)
    card = client.fetch_agent_card()
    transcript = Transcript()

    negotiation_id = env.new_negotiation_id()
    created = now_fn()

    # 1. RFQ → Offer
    rfq = env.build_rfq(
        negotiation_id=negotiation_id,
        sku=sku,
        quantity=quantity,
        delivery_before=delivery_before,
        created_at=created,
    )
    transcript.append(
        _wire_event(rfq, sender="buyer", negotiation_id=negotiation_id, occurred_at=created)
    )
    task = client.send_envelope(rfq, text=f"RFQ: {quantity}x {sku}")
    offer = decline_or_envelope(task)
    transcript.append(
        _wire_event(offer, sender="merchant", negotiation_id=negotiation_id, occurred_at=offer["created_at"])
    )

    # 2. CounterOffer → ConditionalOffer
    counter = env.build_counter_offer(
        negotiation_id=negotiation_id,
        responding_to_offer_id=offer["payload"]["offer_id"],
        sku=sku,
        quantity=quantity,
        amount_minor=counter_price,
        in_reply_to=offer["message_id"],
        created_at=now_fn(),
    )
    transcript.append(
        _wire_event(counter, sender="buyer", negotiation_id=negotiation_id, occurred_at=counter["created_at"])
    )
    task = client.send_envelope(counter)
    conditional = decline_or_envelope(task)
    transcript.append(
        _wire_event(conditional, sender="merchant", negotiation_id=negotiation_id, occurred_at=conditional["created_at"])
    )

    # 3. 求值条件 → Accept → Agreement
    agreed_terms = evaluate_conditional(conditional["payload"], {"aggregate.total_quantity": quantity})
    accept = env.build_accept_nonbinding(
        negotiation_id=negotiation_id,
        accepted_offer_id=conditional["payload"]["offer_id"],
        agreed_terms=agreed_terms,
        in_reply_to=conditional["message_id"],
        created_at=now_fn(),
    )
    transcript.append(
        _wire_event(accept, sender="buyer", negotiation_id=negotiation_id, occurred_at=accept["created_at"])
    )
    task = client.send_envelope(accept)
    agreement = extract_agreement(task)
    if agreement is None:
        raise RuntimeError("no agreement artifact in accept response")

    # 4. KTH HandoffCandidate（不真交易，三副作用恒 false）。
    merchant_identity = f"merchant:{offer['negotiation_id']}"
    destination = _handoff_destination(agreement)
    candidate = build_handoff_candidate(
        agreement_id=agreement["agreement_id"],
        negotiation_id=negotiation_id,
        terms_digest=agreement["terms_digest"],
        buyer_identity_ref=buyer_identity,
        merchant_identity_ref=merchant_identity,
        destination_type=destination["type"],
        destination_ref=destination["ref"],
        created_at=now_fn(),
        expires_at=_expiry(now_fn()),
        display_summary={
            "merchant": merchant_identity,
            "summary": f"{quantity} units, agreed terms digest {agreement['terms_digest'][:16]}…",
        },
    )
    transcript.append(
        handoff_candidate_created_event(
            candidate=candidate,
            buyer_identity_ref=buyer_identity,
            merchant_identity_ref=merchant_identity,
            occurred_at=now_fn(),
            negotiation_id=negotiation_id,
        )
    )

    transcript.verify()
    return {
        "negotiation_id": negotiation_id,
        "card": card,
        "offer": offer,
        "conditional": conditional,
        "agreement": agreement,
        "handoff_candidate": candidate,
        "transcript": transcript,
    }


def _wire_event(envelope: dict, *, sender: str, negotiation_id: str, occurred_at: str) -> dict:
    return {
        "event_kind": "message_sent" if sender == "buyer" else "message_received",
        "negotiation_id": negotiation_id,
        "exchange_id": envelope["exchange_id"],
        "message_id": envelope["message_id"],
        "in_reply_to": envelope.get("in_reply_to"),
        "identity": {
            "sender_identity": f"{sender}:kiwi-ref-python",
            "counterparty_identity": "merchant:kiwi" if sender == "buyer" else "buyer:kiwi-ref-python",
            "actor": envelope["actor"],
        },
        "capability": {
            "capability": envelope["capability"],
            "protocol_version": envelope["protocol_version"],
        },
        "wire_digest": envelope["digest"],
        "outcome": {"kind": "ok"},
        "occurred_at": occurred_at,
    }


def _handoff_destination(agreement: dict) -> dict:
    """从 agreed terms 的 handoff_destination 派生成交入口；缺省用会话引用。"""
    terms = agreement.get("agreed_terms") or {}
    ref = terms.get("handoff_destination")
    if isinstance(ref, str) and ref != "":
        parsed = urllib.parse.urlparse(ref)
        if parsed.scheme in ("http", "https"):
            return {"type": "external_checkout_url", "ref": ref}
        return {"type": "merchant_checkout_session", "ref": ref}
    return {
        "type": "merchant_checkout_session",
        "ref": f"session:{agreement.get('agreement_id', '')}",
    }


def cmd_merchant(args: argparse.Namespace) -> int:
    products = {
        args.sku: {
            "price_minor": args.price,
            "deal_price_minor": args.deal,
            "delivery_before": DEFAULT_DELIVERY_BEFORE,
            "handoff_destination": None,
        }
    }
    server = MerchantHTTPServer(products=products)
    url = server.start(args.port)
    print(f"SUT_URL={url}", flush=True)
    print(f"card={url}/.well-known/agent-card.json", flush=True)
    try:
        while True:
            pass
    except KeyboardInterrupt:
        server.stop()
        return 0


def cmd_buyer(args: argparse.Namespace) -> int:
    result = run_buyer(
        url=args.url,
        sku=args.sku,
        quantity=args.quantity,
        counter_price=args.counter,
    )
    agreement = result["agreement"]
    print(json.dumps({
        "negotiation_id": result["negotiation_id"],
        "offer_action": result["offer"]["action"],
        "conditional_action": result["conditional"]["action"],
        "agreement": {
            "agreement_id": agreement["agreement_id"],
            "binding_effect": agreement["binding_effect"],
            "terms_digest": agreement["terms_digest"],
            "creates_order": agreement["creates_order"],
            "authorizes_payment": agreement["authorizes_payment"],
            "reserves_inventory": agreement["reserves_inventory"],
        },
        "handoff_candidate": {
            "handoff_candidate_id": result["handoff_candidate"]["handoff_candidate_id"],
            "destination_type": result["handoff_candidate"]["destination_type"],
            "destination_ref": result["handoff_candidate"]["destination_ref"],
        },
        "transcript_events": len(result["transcript"].events),
    }, indent=2, ensure_ascii=False))
    if args.jsonl is not None:
        result["transcript"].write_jsonl(args.jsonl)
        print(f"[kiwi-ref] transcript saved: {args.jsonl}", file=sys.stderr)
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    transcript = Transcript.load(args.jsonl)
    transcript.verify()
    print(f"[kiwi-ref] transcript verified: {len(transcript.events)} events, chain intact")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="kiwi-ref", description="Kiwi Negotiation Protocol 参考实现")
    sub = parser.add_subparsers(dest="command", required=True)

    p_merchant = sub.add_parser("merchant", help="启动 A2A merchant 服务")
    p_merchant.add_argument("--port", type=int, default=0)
    p_merchant.add_argument("--sku", default=DEFAULT_SKU)
    p_merchant.add_argument("--price", type=int, default=85000)
    p_merchant.add_argument("--deal", type=int, default=83500)
    p_merchant.set_defaults(func=cmd_merchant)

    p_buyer = sub.add_parser("buyer", help="运行完整买家流程并输出可校验 transcript")
    p_buyer.add_argument("--url", required=True)
    p_buyer.add_argument("--sku", default=DEFAULT_SKU)
    p_buyer.add_argument("--quantity", type=int, default=DEFAULT_QUANTITY)
    p_buyer.add_argument("--counter", type=int, default=DEFAULT_COUNTER_PRICE)
    p_buyer.add_argument("--jsonl", default=None, help="transcript 输出路径")
    p_buyer.set_defaults(func=cmd_buyer)

    p_verify = sub.add_parser("verify", help="校验 transcript 哈希链")
    p_verify.add_argument("--jsonl", required=True)
    p_verify.set_defaults(func=cmd_verify)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
