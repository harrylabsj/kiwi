"""A2A client 测试：wire 帧 + 响应解析（对固定 fixture server）。"""

from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from kiwi_ref import envelope as env
from kiwi_ref.a2a import (
    A2ABusinessDecline,
    A2AClient,
    A2AClientError,
    MAX_RESPONSE_BYTES,
    _read_bounded,
    decline_or_envelope,
    extract_agreement,
    extract_reply_envelope,
)

SKU = "SKU-001"
NOW = "2026-08-13T12:00:00Z"
VALID_UNTIL = "2026-08-14T12:00:00Z"


class _FixtureServer:
    """最小 A2A fixture：按 action 返回固定回复（测试 wire 帧与解析）。"""

    def __init__(self) -> None:
        self.seen: list[dict] = []
        # handler 方法经 class attribute 引用 fixture；`self` 是 handler 实例。
        handler = type(
            "_Handler",
            (BaseHTTPRequestHandler,),
            {
                "do_POST": lambda self: self._fixture._handle_post(self),
                "do_GET": lambda self: self._fixture._handle_get(self),
                "log_message": lambda *_: None,
            },
        )
        handler._fixture = self
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address
        return f"http://{host}:{port}"

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def _handle_post(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length", "0"))
        raw = handler.rfile.read(length)
        body = json.loads(raw.decode("utf-8"))
        self.seen.append({"headers": dict(handler.headers), "body": body})
        method = body["method"]
        assert method == "SendMessage", f"unexpected method {method}"
        msg = body["params"]["message"]
        envelope = next(
            p["data"]["knp_envelope"] for p in msg["parts"] if "knp_envelope" in p.get("data", {})
        )
        action = envelope["action"]
        if action == "rfq":
            reply = env.build_offer(
                negotiation_id=envelope["negotiation_id"],
                in_reply_to=envelope["message_id"],
                terms=env.offer_terms(
                    sku=SKU,
                    quantity=200,
                    amount_minor=85000,
                    delivery_before="2026-08-20T18:00:00Z",
                    valid_until=VALID_UNTIL,
                ),
                created_at=NOW,
            )
            task = _task_with_envelope(reply)
        elif action == "accept_nonbinding":
            agreement = env.build_agreement(
                negotiation_id=envelope["negotiation_id"],
                accepted_offer_id="off_123",
                agreed_terms={},
                created_at=NOW,
            )
            task = {
                "id": "task_1",
                "contextId": "ctx_1",
                "status": {
                    "state": "TASK_STATE_COMPLETED",
                    "message": {"role": "agent", "messageId": "msg_r1", "parts": [{"kind": "text", "text": "Agreement reached (nonbinding)."}]},
                },
                "artifacts": [{"artifactId": "art_1", "parts": [{"kind": "data", "data": {"agreement": agreement}}]}],
            }
        elif action == "withdraw":
            # 业务拒绝 fixture：decline data part。
            task = {
                "id": "task_1",
                "status": {
                    "state": "TASK_STATE_COMPLETED",
                    "message": {
                        "role": "agent",
                        "messageId": "msg_r2",
                        "parts": [{"kind": "data", "data": {"decline": True, "reason_code": "offer_unknown", "message": "no such offer"}}],
                    },
                },
            }
        else:
            self._send_error(handler, body["id"], "unexpected action")
            return
        payload = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": {"task": task}}).encode()
        self._send(handler, payload, 200)

    def _handle_get(self, handler: BaseHTTPRequestHandler) -> None:
        if handler.path == "/.well-known/agent-card.json":
            card = {
                "name": "Fixture Merchant",
                "description": "A2A test merchant",
                "provider": {"organization": "Fixture Org"},
                "version": "1.0.0",
                "supportedInterfaces": [
                    {"url": f"{self.url}/", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
                ],
                "capabilities": {"extendedAgentCard": True},
            }
            payload = json.dumps(card).encode()
            self._send(handler, payload, 200)
            return
        self._send(handler, b"not found", 404)

    def _send_error(self, handler: BaseHTTPRequestHandler, rpc_id: str, message: str) -> None:
        payload = json.dumps({"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32600, "message": message}}).encode()
        self._send(handler, payload, 200)

    def _send(self, handler: BaseHTTPRequestHandler, payload: bytes, status: int) -> None:
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(payload)))
        handler.end_headers()
        handler.wfile.write(payload)


def _task_with_envelope(envelope: dict) -> dict:
    return {
        "id": "task_1",
        "contextId": "ctx_1",
        "status": {
            "state": "TASK_STATE_WORKING",
            "message": {
                "role": "agent",
                "messageId": envelope["message_id"],
                "parts": [{"kind": "data", "data": {"knp_envelope": envelope}}],
            },
        },
    }


class A2AClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = _FixtureServer()
        self.fixture.start()
        self.addCleanup(self.fixture.stop)
        self.client = A2AClient(self.fixture.url)

    def test_send_rfq_receives_offer_envelope(self) -> None:
        rfq = env.build_rfq(
            negotiation_id=env.new_negotiation_id(),
            sku=SKU,
            quantity=200,
            delivery_before="2026-08-20T18:00:00Z",
            created_at=NOW,
        )
        task = self.client.send_envelope(rfq, text="RFQ: 200x SKU-001")
        reply = decline_or_envelope(task)
        self.assertEqual(reply["action"], "offer")
        self.assertEqual(reply["actor"], "merchant")
        self.assertEqual(reply["in_reply_to"], rfq["message_id"])

    def test_wire_headers_and_framing(self) -> None:
        rfq = env.build_rfq(
            negotiation_id=env.new_negotiation_id(),
            sku=SKU,
            quantity=200,
            delivery_before="2026-08-20T18:00:00Z",
            created_at=NOW,
        )
        self.client.send_envelope(rfq)
        seen = self.fixture.seen[0]
        # HTTP 头名大小写不敏感：统一小写后断言。
        headers = {k.lower(): v for k, v in seen["headers"].items()}
        self.assertEqual(headers.get("a2a-version"), "1.0")
        self.assertTrue(headers.get("a2a-extensions", "").endswith("/a2a/extensions/negotiation/1.0"))
        self.assertEqual(seen["body"]["method"], "SendMessage")
        part = seen["body"]["params"]["message"]["parts"][-1]
        self.assertEqual(part["mediaType"], "application/json")
        self.assertIn("knp_envelope", part["data"])

    def test_accept_receives_agreement_artifact(self) -> None:
        accept = env.build_accept_nonbinding(
            negotiation_id=env.new_negotiation_id(),
            accepted_offer_id="off_123",
            agreed_terms={},
            in_reply_to="msg_x",
            created_at=NOW,
        )
        task = self.client.send_envelope(accept)
        agreement = extract_agreement(task)
        self.assertIsNotNone(agreement)
        assert agreement is not None
        self.assertEqual(agreement["type"], "accepted_nonbinding_agreement")
        self.assertFalse(agreement["creates_order"])
        self.assertFalse(agreement["authorizes_payment"])
        self.assertFalse(agreement["reserves_inventory"])

    def test_business_decline_raises(self) -> None:
        decline = env.finalize_envelope(
            {
                "capability": env.CAPABILITY,
                "protocol_version": "1.0",
                "negotiation_id": env.new_negotiation_id(),
                "exchange_id": env.new_exchange_id(),
                "message_id": env.new_message_id(),
                "actor": "buyer",
                "action": "withdraw",
                "created_at": NOW,
                "payload": {"type": "withdraw", "target_message_id": "msg_x", "scope": "offer"},
            }
        )
        task = self.client.send_envelope(decline)
        with self.assertRaises(A2ABusinessDecline) as ctx:
            decline_or_envelope(task)
        self.assertEqual(ctx.exception.reason_code, "offer_unknown")

    def test_response_body_limit_is_fail_closed(self) -> None:
        class Response:
            def __init__(self, payload: bytes, declared: str | None = None) -> None:
                self.payload = payload
                self.headers = {} if declared is None else {"Content-Length": declared}

            def read(self, limit: int) -> bytes:
                return self.payload[:limit]

        with self.assertRaises(A2AClientError):
            _read_bounded(Response(b"x", str(MAX_RESPONSE_BYTES + 1)), MAX_RESPONSE_BYTES, "test")
        with self.assertRaises(A2AClientError):
            _read_bounded(Response(b"x" * (MAX_RESPONSE_BYTES + 1)), MAX_RESPONSE_BYTES, "test")


class AgentCardTest(unittest.TestCase):
    def test_fetch_agent_card(self) -> None:
        # 内嵌一个只服务 /.well-known/agent-card.json 的 fixture。
        fixture = _FixtureServer()
        fixture.start()
        self.addCleanup(fixture.stop)
        client = A2AClient(fixture.url)
        card = client.fetch_agent_card()
        self.assertIsInstance(card, dict)


if __name__ == "__main__":
    unittest.main()
