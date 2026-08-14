"""Merchant 相位机测试：happy path + fail-closed（非法转换/终态拒绝/terms_digest）。"""

from __future__ import annotations

import unittest
from urllib.parse import urlsplit

from kiwi_ref import envelope as env
from kiwi_ref.a2a import A2ABusinessDecline, A2AClient, decline_or_envelope, extract_agreement
from kiwi_ref.conditional import evaluate_conditional, matches
from kiwi_ref.jcs import content_digest
from kiwi_ref.merchant import (
    DEFAULT_PRODUCT,
    Merchant,
    MerchantDecline,
    MerchantHTTPServer,
    MAX_REQUEST_BODY_BYTES,
)

NOW = "2026-08-13T12:00:00Z"
SKU = "SKU-001"


def _rfq(negotiation_id: str, quantity: int = 200) -> dict:
    return env.build_rfq(
        negotiation_id=negotiation_id,
        sku=SKU,
        quantity=quantity,
        delivery_before="2026-08-20T18:00:00Z",
        created_at=NOW,
    )


class ConditionalEvaluatorTest(unittest.TestCase):
    def test_leaf_match_and_miss(self) -> None:
        facts = {"aggregate.total_quantity": 200}
        self.assertTrue(matches({"field": "aggregate.total_quantity", "op": "gte", "value": 100}, facts))
        self.assertFalse(matches({"field": "aggregate.total_quantity", "op": "gte", "value": 500}, facts))
        self.assertTrue(matches({"field": "aggregate.total_quantity", "op": "in", "value": [100, 200]}, facts))

    def test_all_any_composition(self) -> None:
        facts = {"aggregate.total_quantity": 200, "fulfillment.batch_count": 1}
        self.assertTrue(
            matches({"all": [{"field": "aggregate.total_quantity", "op": "gte", "value": 100}]}, facts)
        )
        self.assertTrue(
            matches(
                {
                    "any": [
                        {"field": "aggregate.total_quantity", "op": "lt", "value": 100},
                        {"field": "aggregate.total_quantity", "op": "gte", "value": 100},
                    ]
                },
                facts,
            )
        )

    def test_evaluate_falls_back_to_base_terms(self) -> None:
        conditional = {
            "type": "conditional_offer",
            "offer_id": "off_1",
            "base_terms": {"items": [{"sku": SKU, "unit_price": {"amount_minor": 85000}}]},
            "conditions": [
                {"when": {"all": [{"field": "aggregate.total_quantity", "op": "gte", "value": 500}]}, "then_terms": {"items": []}}
            ],
        }
        self.assertEqual(
            evaluate_conditional(conditional, {"aggregate.total_quantity": 200}),
            conditional["base_terms"],
        )
        self.assertEqual(
            evaluate_conditional(conditional, {"aggregate.total_quantity": 900}),
            conditional["conditions"][0]["then_terms"],
        )


class MerchantPhaseMachineTest(unittest.TestCase):
    def test_full_negotiation_happy_path(self) -> None:
        merchant = Merchant()
        negotiation_id = env.new_negotiation_id()
        task = merchant.handle_envelope(_rfq(negotiation_id), now=NOW)
        reply = decline_or_envelope(task)
        self.assertEqual(reply["action"], "offer")
        offer_id = reply["payload"]["offer_id"]
        terms = reply["payload"]["terms"]
        self.assertEqual(terms["items"][0]["unit_price"]["amount_minor"], DEFAULT_PRODUCT["price_minor"])

        counter = env.build_counter_offer(
            negotiation_id=negotiation_id,
            responding_to_offer_id=offer_id,
            sku=SKU,
            quantity=200,
            amount_minor=83000,
            in_reply_to=reply["message_id"],
            created_at=NOW,
        )
        task = merchant.handle_envelope(counter, now=NOW)
        conditional = decline_or_envelope(task)
        self.assertEqual(conditional["action"], "conditional_offer")
        conditional_id = conditional["payload"]["offer_id"]

        # 买家求值条件：quantity 200 gte 100 → then_terms（折扣价 83500）。
        agreed = evaluate_conditional(conditional["payload"], {"aggregate.total_quantity": 200})
        self.assertEqual(agreed["items"][0]["unit_price"]["amount_minor"], DEFAULT_PRODUCT["deal_price_minor"])

        accept = env.build_accept_nonbinding(
            negotiation_id=negotiation_id,
            accepted_offer_id=conditional_id,
            agreed_terms=agreed,
            in_reply_to=conditional["message_id"],
            created_at=NOW,
        )
        task = merchant.handle_envelope(accept, now=NOW)
        agreement = extract_agreement(task)
        self.assertIsNotNone(agreement)
        assert agreement is not None
        self.assertEqual(agreement["type"], "accepted_nonbinding_agreement")
        self.assertEqual(agreement["accepted_offer_id"], conditional_id)
        self.assertEqual(agreement["terms_digest"], content_digest(agreed))
        self.assertFalse(agreement["creates_order"])
        self.assertFalse(agreement["authorizes_payment"])
        self.assertFalse(agreement["reserves_inventory"])
        self.assertTrue(merchant.is_terminal(negotiation_id))

    def test_terminal_rejects_new_commercial_action(self) -> None:
        merchant = Merchant()
        negotiation_id = env.new_negotiation_id()
        # 完整走到 AGREEMENT_REACHED（终态）。
        reply = decline_or_envelope(merchant.handle_envelope(_rfq(negotiation_id), now=NOW))
        counter = env.build_counter_offer(
            negotiation_id=negotiation_id,
            responding_to_offer_id=reply["payload"]["offer_id"],
            sku=SKU,
            quantity=200,
            amount_minor=83000,
            in_reply_to=reply["message_id"],
            created_at=NOW,
        )
        conditional = decline_or_envelope(merchant.handle_envelope(counter, now=NOW))
        agreed = evaluate_conditional(conditional["payload"], {"aggregate.total_quantity": 200})
        accept = env.build_accept_nonbinding(
            negotiation_id=negotiation_id,
            accepted_offer_id=conditional["payload"]["offer_id"],
            agreed_terms=agreed,
            in_reply_to=conditional["message_id"],
            created_at=NOW,
        )
        merchant.handle_envelope(accept, now=NOW)
        self.assertTrue(merchant.is_terminal(negotiation_id))
        # 终态后再发商业动作 → state_conflict。
        with self.assertRaises(MerchantDecline) as ctx:
            merchant.handle_envelope(_rfq(negotiation_id), now=NOW)
        self.assertEqual(ctx.exception.reason_code, "state_conflict")

    def test_accept_without_conditional_is_offer_unknown(self) -> None:
        merchant = Merchant()
        negotiation_id = env.new_negotiation_id()
        accept = env.build_accept_nonbinding(
            negotiation_id=negotiation_id,
            accepted_offer_id="off_nope",
            agreed_terms={},
            in_reply_to="msg_x",
            created_at=NOW,
        )
        with self.assertRaises(MerchantDecline) as ctx:
            merchant.handle_envelope(accept, now=NOW)
        self.assertEqual(ctx.exception.reason_code, "offer_unknown")

    def test_terms_digest_mismatch_declined(self) -> None:
        merchant = Merchant()
        negotiation_id = env.new_negotiation_id()
        reply = decline_or_envelope(merchant.handle_envelope(_rfq(negotiation_id), now=NOW))
        counter = env.build_counter_offer(
            negotiation_id=negotiation_id,
            responding_to_offer_id=reply["payload"]["offer_id"],
            sku=SKU,
            quantity=200,
            amount_minor=83000,
            in_reply_to=reply["message_id"],
            created_at=NOW,
        )
        conditional = decline_or_envelope(merchant.handle_envelope(counter, now=NOW))
        wrong_terms = {"items": [{"sku": SKU, "unit_price": {"amount_minor": 1}}]}
        accept = env.build_accept_nonbinding(
            negotiation_id=negotiation_id,
            accepted_offer_id=conditional["payload"]["offer_id"],
            agreed_terms=wrong_terms,
            in_reply_to=conditional["message_id"],
            created_at=NOW,
        )
        with self.assertRaises(MerchantDecline) as ctx:
            merchant.handle_envelope(accept, now=NOW)
        self.assertEqual(ctx.exception.reason_code, "terms_digest_mismatch")

    def test_invalid_envelope_digest_rejected(self) -> None:
        merchant = Merchant()
        negotiation_id = env.new_negotiation_id()
        rfq = _rfq(negotiation_id)
        rfq["payload"]["items"][0]["quantity"]["value"] = 1  # 篡改，digest 失效
        with self.assertRaises(env.EnvelopeError):
            merchant.handle_envelope(rfq, now=NOW)


class MerchantOverHttpTest(unittest.TestCase):
    def test_full_flow_over_http(self) -> None:
        server = MerchantHTTPServer()
        url = server.start()
        self.addCleanup(server.stop)
        client = A2AClient(url)

        negotiation_id = env.new_negotiation_id()
        rfq = _rfq(negotiation_id)
        task = client.send_envelope(rfq, text="RFQ: 200x SKU-001")
        offer = decline_or_envelope(task)

        counter = env.build_counter_offer(
            negotiation_id=negotiation_id,
            responding_to_offer_id=offer["payload"]["offer_id"],
            sku=SKU,
            quantity=200,
            amount_minor=83000,
            in_reply_to=offer["message_id"],
            created_at=NOW,
        )
        task = client.send_envelope(counter)
        conditional = decline_or_envelope(task)

        agreed = evaluate_conditional(conditional["payload"], {"aggregate.total_quantity": 200})
        accept = env.build_accept_nonbinding(
            negotiation_id=negotiation_id,
            accepted_offer_id=conditional["payload"]["offer_id"],
            agreed_terms=agreed,
            in_reply_to=conditional["message_id"],
            created_at=NOW,
        )
        task = client.send_envelope(accept)
        agreement = extract_agreement(task)
        self.assertIsNotNone(agreement)
        assert agreement is not None
        self.assertEqual(agreement["binding_effect"], "nonbinding")
        self.assertFalse(agreement["authorizes_payment"])

    def test_business_decline_over_http(self) -> None:
        server = MerchantHTTPServer()
        url = server.start()
        self.addCleanup(server.stop)
        client = A2AClient(url)
        negotiation_id = env.new_negotiation_id()
        accept = env.build_accept_nonbinding(
            negotiation_id=negotiation_id,
            accepted_offer_id="off_nope",
            agreed_terms={},
            in_reply_to="msg_x",
            created_at=NOW,
        )
        task = client.send_envelope(accept)
        with self.assertRaises(A2ABusinessDecline) as ctx:
            decline_or_envelope(task)
        self.assertEqual(ctx.exception.reason_code, "offer_unknown")

    def test_oversized_request_is_rejected_before_json_parse(self) -> None:
        server = MerchantHTTPServer()
        url = server.start()
        self.addCleanup(server.stop)
        target = urlsplit(url)
        # 服务端按 Content-Length header 拒绝（413），不读 body。用原始 socket 只发
        # header + 极短 body，避免客户端在服务端提前关闭时被 reset。
        import socket

        with socket.create_connection((target.hostname, target.port), timeout=5) as sock:
            sock.sendall(
                (
                    "POST / HTTP/1.1\r\n"
                    f"Host: {target.hostname}:{target.port}\r\n"
                    "Content-Type: application/json\r\n"
                    f"Content-Length: {MAX_REQUEST_BODY_BYTES + 1}\r\n"
                    "Connection: close\r\n"
                    "\r\n"
                ).encode()
                + b'{"jsonrpc":'
            )
            sock.settimeout(5)
            head = b""
            while b"\r\n" not in head:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                head += chunk
        self.assertIn(b"413", head.split(b"\r\n")[0])


if __name__ == "__main__":
    unittest.main()
