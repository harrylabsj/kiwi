"""envelope 测试：构造 / digest / 校验，锚定 TS 助手形状与 golden digest。"""

from __future__ import annotations

import json
import os
import unittest

from kiwi_ref.envelope import (
    CAPABILITY,
    EnvelopeError,
    build_accept_nonbinding,
    build_counter_offer,
    build_rfq,
    compute_envelope_digest,
    finalize_envelope,
    validate_envelope,
    verify_envelope_digest,
)
from kiwi_ref.jcs import content_digest

_CONTRACTS_INTEROP = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "contracts", "interop")
)
_DATA_PART_EXAMPLES = os.path.join(_CONTRACTS_INTEROP, "knp-data-part-examples.json")

NEGOTIATION_ID = "neg_01H5V8KXZqJ7Qp3mN2B6A"
SKU = "SKU-001"
DELIVERY_BEFORE = "2026-08-20T18:00:00Z"
NOW = "2026-08-13T12:00:00Z"


def _load_example_envelope(label: str) -> dict:
    with open(_DATA_PART_EXAMPLES, encoding="utf-8") as f:
        examples = json.load(f)["examples"]
    for ex in examples:
        if ex["label"] == label:
            carrier = ex["message"] if "message" in ex else ex["task"]["status"]["message"]
            for part in carrier["parts"]:
                if part.get("kind") == "data" and "knp_envelope" in part["data"]:
                    return part["data"]["knp_envelope"]
    raise AssertionError(f"no example envelope labeled {label}")


class BuildAndVerify(unittest.TestCase):
    def test_rfq_roundtrip(self) -> None:
        env = build_rfq(
            negotiation_id=NEGOTIATION_ID,
            sku=SKU,
            quantity=200,
            delivery_before=DELIVERY_BEFORE,
            created_at=NOW,
        )
        # finalize 已含 digest；校验通过 = digest 一致 + 结构合法。
        validate_envelope(env)
        self.assertEqual(env["actor"], "buyer")
        self.assertEqual(env["action"], "rfq")
        self.assertTrue(env["digest"].startswith("sha256:"))

    def test_digest_tamper_detected(self) -> None:
        env = build_rfq(
            negotiation_id=NEGOTIATION_ID,
            sku=SKU,
            quantity=200,
            delivery_before=DELIVERY_BEFORE,
            created_at=NOW,
        )
        env["payload"]["items"][0]["quantity"]["value"] = 999
        self.assertFalse(verify_envelope_digest(env))

    def test_finalize_rejects_existing_digest(self) -> None:
        env = build_rfq(
            negotiation_id=NEGOTIATION_ID,
            sku=SKU,
            quantity=200,
            delivery_before=DELIVERY_BEFORE,
            created_at=NOW,
        )
        with self.assertRaises(EnvelopeError):
            finalize_envelope(env)

    def test_validate_fail_closed(self) -> None:
        env = build_rfq(
            negotiation_id=NEGOTIATION_ID,
            sku=SKU,
            quantity=200,
            delivery_before=DELIVERY_BEFORE,
            created_at=NOW,
        )
        bad = dict(env)
        bad["actor"] = "hacker"
        with self.assertRaises(EnvelopeError):
            validate_envelope(bad)
        bad2 = dict(env)
        bad2["action"] = "not_an_action"
        with self.assertRaises(EnvelopeError):
            validate_envelope(bad2)
        bad3 = dict(env)
        bad3.pop("payload")
        with self.assertRaises(EnvelopeError):
            validate_envelope(bad3)

    def test_cross_impl_digest_recompute(self) -> None:
        """TS 生成的 interop envelope（含 digest）由本实现重算必须一致。"""
        for label in ("counter_offer", "offer", "inquiry", "accept_nonbinding"):
            envelope = _load_example_envelope(label)
            recomputed = compute_envelope_digest(envelope)
            self.assertEqual(recomputed, envelope["digest"], f"{label} digest mismatch")


class GoldenVectors(unittest.TestCase):
    """TS `tests/knp-conformance-vectors.test.ts` 的 4 个 golden digest。

    向量字段与 shopping-cli Python port 完全一致；本实现复算必须命中。
    """

    COUNTER_OFFER = "sha256:87517fc5c7d13be7abba1e02349632e891aa1062da9339e90dd6249c0e985295"
    OFFER = "sha256:99dfb819f5668835005582cfb1db4992d5bd13fa9059e4b2298dda1c466b5742"
    INQUIRY = "sha256:a08539767c6fc46ddc8111fd0b1f320e85978dd164c4ed7bf592646305e91736"
    ACCEPT = "sha256:0231490ea2ff95b8d9a230f2dfb8901ade73f56f0e1f71921bed4157b89c69da"

    def test_golden_digests_match_interop_examples(self) -> None:
        # interop 例子（TS dist 生成）自带的 digest 就是 golden 值。
        self.assertEqual(_load_example_envelope("counter_offer")["digest"], self.COUNTER_OFFER)
        self.assertEqual(_load_example_envelope("offer")["digest"], self.OFFER)
        self.assertEqual(_load_example_envelope("inquiry")["digest"], self.INQUIRY)
        self.assertEqual(_load_example_envelope("accept_nonbinding")["digest"], self.ACCEPT)


if __name__ == "__main__":
    unittest.main()
