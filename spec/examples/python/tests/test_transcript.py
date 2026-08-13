"""transcript + handoff 测试：哈希链可验证性、三 false 不变量、KTH 事件。"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from kiwi_ref import envelope as env
from kiwi_ref.handoff import (
    assert_no_side_effects,
    build_handoff_candidate,
    handoff_candidate_created_event,
    verify_candidate_digest,
)
from kiwi_ref.jcs import content_digest
from kiwi_ref.transcript import Transcript, TranscriptError

NOW = "2026-08-13T12:00:00Z"
EXPIRES = "2026-08-14T12:00:00Z"


def _envelope_event(envelope: dict, kind: str = "message_sent") -> dict:
    return {
        "event_kind": kind,
        "negotiation_id": envelope["negotiation_id"],
        "exchange_id": envelope["exchange_id"],
        "message_id": envelope["message_id"],
        "in_reply_to": envelope.get("in_reply_to"),
        "identity": {"sender_identity": "buyer:ref", "counterparty_identity": "merchant:ref", "actor": envelope["actor"]},
        "capability": {"capability": envelope["capability"], "protocol_version": envelope["protocol_version"]},
        "wire_digest": envelope["digest"],
        "outcome": {"kind": "ok"},
        "occurred_at": envelope["created_at"],
    }


class TranscriptTest(unittest.TestCase):
    def test_append_chain_and_verify(self) -> None:
        t = Transcript()
        neg = env.new_negotiation_id()
        rfq = env.build_rfq(negotiation_id=neg, sku="SKU-001", quantity=200, delivery_before="2026-08-20T18:00:00Z", created_at=NOW)
        e1 = t.append(_envelope_event(rfq))
        e2 = t.append(_envelope_event(rfq, kind="message_received"))
        self.assertIsNone(e1["previous_event_digest"])
        self.assertEqual(e2["previous_event_digest"], e1["event_digest"])
        t.verify()  # 不抛 = 链可验证

    def test_tamper_detected(self) -> None:
        t = Transcript()
        neg = env.new_negotiation_id()
        rfq = env.build_rfq(negotiation_id=neg, sku="SKU-001", quantity=200, delivery_before="2026-08-20T18:00:00Z", created_at=NOW)
        t.append(_envelope_event(rfq))
        t.events[0]["wire_digest"] = "sha256:" + "0" * 64  # 篡改
        with self.assertRaises(TranscriptError) as ctx:
            t.verify()
        self.assertEqual(ctx.exception.kind, "tampered")

    def test_chain_break_detected(self) -> None:
        t = Transcript()
        neg = env.new_negotiation_id()
        rfq = env.build_rfq(negotiation_id=neg, sku="SKU-001", quantity=200, delivery_before="2026-08-20T18:00:00Z", created_at=NOW)
        e1 = t.append(_envelope_event(rfq))
        e2 = t.append(_envelope_event(rfq, kind="message_received"))
        e2["previous_event_digest"] = None  # 断链
        with self.assertRaises(TranscriptError) as ctx:
            t.verify()
        self.assertEqual(ctx.exception.kind, "chain_break")

    def test_jsonl_roundtrip(self) -> None:
        t = Transcript()
        neg = env.new_negotiation_id()
        rfq = env.build_rfq(negotiation_id=neg, sku="SKU-001", quantity=200, delivery_before="2026-08-20T18:00:00Z", created_at=NOW)
        t.append(_envelope_event(rfq))
        t.append(_envelope_event(rfq, kind="message_received"))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "transcript.jsonl")
            t.write_jsonl(path)
            loaded = Transcript.load(path)
        loaded.verify()
        self.assertEqual(len(loaded.events), 2)

    def test_duplicate_digest_detected(self) -> None:
        t = Transcript()
        neg = env.new_negotiation_id()
        rfq = env.build_rfq(negotiation_id=neg, sku="SKU-001", quantity=200, delivery_before="2026-08-20T18:00:00Z", created_at=NOW)
        content = _envelope_event(rfq)
        # 同一内容 append 两次（链上事件 identical 但 digest 相同）。
        t.append(content)
        t.append(dict(content))
        with self.assertRaises(TranscriptError) as ctx:
            t.verify()
        self.assertEqual(ctx.exception.kind, "duplicate")


class HandoffTest(unittest.TestCase):
    def test_candidate_three_false_invariants(self) -> None:
        terms = {"items": [{"sku": "SKU-001", "unit_price": {"amount_minor": 83500}}]}
        candidate = build_handoff_candidate(
            agreement_id="agr_1",
            negotiation_id="neg_1",
            terms_digest=content_digest(terms),
            buyer_identity_ref="buyer:ref",
            merchant_identity_ref="merchant:ref",
            destination_type="external_checkout_url",
            destination_ref="https://merchant.example/checkout/abc",
            created_at=NOW,
            expires_at=EXPIRES,
        )
        self.assertTrue(verify_candidate_digest(candidate))
        assert_no_side_effects(candidate)  # 不抛 = 三 false 成立
        self.assertFalse(candidate["creates_order"])
        self.assertFalse(candidate["authorizes_payment"])
        self.assertFalse(candidate["reserves_inventory"])

    def test_candidate_digest_tamper_detected(self) -> None:
        candidate = build_handoff_candidate(
            agreement_id="agr_1",
            negotiation_id="neg_1",
            terms_digest="sha256:" + "a" * 64,
            buyer_identity_ref="buyer:ref",
            merchant_identity_ref="merchant:ref",
            destination_type="quote_document",
            destination_ref="ref-1",
            created_at=NOW,
            expires_at=EXPIRES,
        )
        candidate["requires_user_action"] = False  # 篡改
        self.assertFalse(verify_candidate_digest(candidate))

    def test_invalid_destination_type_rejected(self) -> None:
        with self.assertRaises(Exception):
            build_handoff_candidate(
                agreement_id="agr_1",
                negotiation_id="neg_1",
                terms_digest="sha256:" + "a" * 64,
                buyer_identity_ref="b",
                merchant_identity_ref="m",
                destination_type="not-a-real-destination",
                destination_ref="x",
                created_at=NOW,
                expires_at=EXPIRES,
            )

    def test_side_effect_flag_guard(self) -> None:
        candidate = build_handoff_candidate(
            agreement_id="agr_1",
            negotiation_id="neg_1",
            terms_digest="sha256:" + "a" * 64,
            buyer_identity_ref="b",
            merchant_identity_ref="m",
            destination_type="ucp_checkout",
            destination_ref="sess-1",
            created_at=NOW,
            expires_at=EXPIRES,
        )
        candidate["creates_order"] = True
        with self.assertRaises(Exception) as ctx:
            assert_no_side_effects(candidate)
        self.assertIn("creates_order", str(ctx.exception))

    def test_kth_event_in_transcript(self) -> None:
        t = Transcript()
        neg = env.new_negotiation_id()
        terms = {"items": [{"sku": "SKU-001", "unit_price": {"amount_minor": 83500}}]}
        candidate = build_handoff_candidate(
            agreement_id="agr_1",
            negotiation_id=neg,
            terms_digest=content_digest(terms),
            buyer_identity_ref="buyer:ref",
            merchant_identity_ref="merchant:ref",
            destination_type="external_checkout_url",
            destination_ref="https://merchant.example/checkout/abc",
            created_at=NOW,
            expires_at=EXPIRES,
        )
        event = t.append(
            handoff_candidate_created_event(
                candidate=candidate,
                buyer_identity_ref="buyer:ref",
                merchant_identity_ref="merchant:ref",
                occurred_at=NOW,
                negotiation_id=neg,
            )
        )
        self.assertEqual(event["event_kind"], "handoff_candidate_created")
        # candidate 完整内嵌在 outcome.result.candidate（可重建/审计）。
        embedded = event["outcome"]["result"]["candidate"]
        self.assertEqual(embedded["handoff_candidate_id"], candidate["handoff_candidate_id"])
        t.verify()
        # 三 false 在事件内嵌候选上同样成立。
        assert_no_side_effects(embedded)


if __name__ == "__main__":
    unittest.main()
