"""最小 A2A merchant（KNP 相位机）— 零 kiwi 依赖，纯标准库。

镜像 Kiwi TS `src/a2a/server/merchant-handler.ts` 的 happy-path 流程：

- RFQ → Offer（商家价）→ 相位 OFFER_OPEN
- Offer（买家）→ CounterOffer（商家价）
- CounterOffer → ConditionalOffer（批量条件：aggregate.total_quantity gte 100 → 折扣价）
- AcceptNonbinding → 校验条件成交 + terms_digest → Agreement artifact（三副作用恒 false）
- Clarification → ClarificationResponse；Withdraw/Decline/Cancel → 终态

``handle_envelope`` 是纯状态机（可离线测试）；``serve`` 包一层
``http.server`` 暴露 A2A SendMessage 端点。入站 envelope 必须先过
``validate_envelope``（结构 + digest，fail-closed）；非法 → JSON-RPC error。
"""

from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import envelope as env
from .conditional import evaluate_conditional
from .jcs import content_digest

MERCHANT_CURRENCY = "CNY"
MERCHANT_DELIVERY_BEFORE = "2026-08-20T18:00:00Z"
OFFER_VALIDITY_MS = 24 * 60 * 60 * 1000  # 24h 报价有效期（TS 同款）

# 商品价目表（demo 数据源）。价格 minor 单位。
DEFAULT_PRODUCT = {
    "price_minor": 85000,       # offer 初始报价
    "deal_price_minor": 83500,  # 批量条件成交价
    "delivery_before": MERCHANT_DELIVERY_BEFORE,
    "handoff_destination": None,
}
PRODUCTS: dict[str, dict] = {
    "SKU-001": dict(DEFAULT_PRODUCT),
    "VQ-003": dict(DEFAULT_PRODUCT),
}


class MerchantDecline(ValueError):
    """商业拒绝：转换为 decline 回复 task（reason_code 见 KNP 词表）。"""

    def __init__(self, reason_code: str, message: str = "") -> None:
        super().__init__(message or reason_code)
        self.reason_code = reason_code


def _valid_until(now: str) -> str:
    from datetime import datetime, timedelta, timezone

    dt = datetime.fromisoformat(now.replace("Z", "+00:00"))
    return (dt + timedelta(milliseconds=OFFER_VALIDITY_MS)).astimezone(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.%f"
    )[:-3] + "Z"


def _task_id() -> str:
    return f"task_{uuid.uuid4().hex}"


def _context_id() -> str:
    return f"ctx_{uuid.uuid4().hex}"


class Merchant:
    """KNP 相位机。按 negotiation_id 维护每磋商状态（内存）。"""

    def __init__(self, *, products: dict[str, dict] | None = None) -> None:
        self.products = dict(PRODUCTS if products is None else products)
        self._phase: dict[str, str] = {}
        self._conditional: dict[str, dict] = {}  # negotiation_id -> conditional payload
        self._quantity: dict[str, int] = {}

    # -- 状态查询（测试用） --------------------------------------------------

    def phase(self, negotiation_id: str) -> str:
        return self._phase.get(negotiation_id, "OPEN")

    def is_terminal(self, negotiation_id: str) -> bool:
        return self.phase(negotiation_id) in {"AGREEMENT_REACHED", "WITHDRAWN", "DECLINED", "CANCELED"}

    # -- 入站处理 -----------------------------------------------------------

    def handle_envelope(self, envelope: dict, *, now: str) -> dict:
        """处理一条合法 envelope，返回回复 task。非法入站由调用方（HTTP 层）拒绝。"""
        env.validate_envelope(envelope)
        negotiation_id = envelope["negotiation_id"]
        in_reply_to = envelope["message_id"]
        action = envelope["action"]
        payload = envelope["payload"]

        if self.is_terminal(negotiation_id):
            raise MerchantDecline("state_conflict", "negotiation already terminal")

        if action == "rfq":
            items = payload.get("items") or []
            if not items:
                raise MerchantDecline("schema_invalid", "rfq requires items")
            sku = str(items[0]["sku"])
            quantity = int(items[0]["quantity"]["value"])
            product = self.products.get(sku)
            if product is None:
                raise MerchantDecline("temporarily_unavailable", f"unknown sku {sku}")
            reply = env.build_offer(
                negotiation_id=negotiation_id,
                in_reply_to=in_reply_to,
                terms=self._offer_terms(product, sku, quantity, now),
                created_at=now,
            )
            self._phase[negotiation_id] = "OFFER_OPEN"
            return self._envelope_task(reply)

        if action == "offer":
            # 买家主动出 offer → 商家还价 counter_offer。
            items = (payload.get("terms") or {}).get("items") or []
            if not items:
                raise MerchantDecline("schema_invalid", "offer requires terms.items")
            sku = str(items[0]["sku"])
            quantity = int(items[0]["quantity"]["value"])
            product = self.products.get(sku)
            if product is None:
                raise MerchantDecline("temporarily_unavailable", f"unknown sku {sku}")
            reply = env.build_counter_offer(
                negotiation_id=negotiation_id,
                responding_to_offer_id=str(payload.get("offer_id") or ""),
                sku=sku,
                quantity=quantity,
                amount_minor=product["price_minor"],
                in_reply_to=in_reply_to,
                created_at=now,
            )
            self._phase[negotiation_id] = "OFFER_OPEN"
            return self._envelope_task(reply)

        if action == "counter_offer":
            items = (payload.get("proposed_terms") or {}).get("items") or []
            if not items:
                raise MerchantDecline("schema_invalid", "counter_offer requires proposed_terms.items")
            sku = str(items[0]["sku"])
            quantity = int(items[0]["quantity"]["value"])
            product = self.products.get(sku)
            if product is None:
                raise MerchantDecline("temporarily_unavailable", f"unknown sku {sku}")
            base_terms = self._offer_terms(product, sku, quantity, now)
            deal_terms = self._offer_terms(
                product, sku, quantity, now, override_price=product["deal_price_minor"]
            )
            reply = env.build_conditional_offer(
                negotiation_id=negotiation_id,
                in_reply_to=in_reply_to,
                responding_to_offer_id=str(payload.get("offer_id") or ""),
                base_terms=base_terms,
                then_terms=deal_terms,
                quantity_threshold=100,
                created_at=now,
            )
            self._conditional[negotiation_id] = reply["payload"]
            self._quantity[negotiation_id] = quantity
            self._phase[negotiation_id] = "OFFER_OPEN"
            return self._envelope_task(reply)

        if action == "accept_nonbinding":
            stored = self._conditional.get(negotiation_id)
            accepted_offer_id = str(payload.get("offer_id") or "")
            stored_offer_id = str((stored or {}).get("offer_id") or "")
            if stored is None or accepted_offer_id == "" or accepted_offer_id != stored_offer_id:
                raise MerchantDecline("offer_unknown", "no matching conditional offer")
            facts = {"aggregate.total_quantity": self._quantity.get(negotiation_id, 0)}
            agreed_terms = evaluate_conditional(stored, facts)
            valid_until = agreed_terms.get("valid_until")
            if valid_until is not None and valid_until < now:
                raise MerchantDecline("offer_expired", "offer expired")
            presented = str(payload.get("terms_digest") or "")
            if presented == "" or presented != content_digest(agreed_terms):
                raise MerchantDecline("terms_digest_mismatch", "terms_digest does not match agreed terms")
            agreement = env.build_agreement(
                negotiation_id=negotiation_id,
                accepted_offer_id=accepted_offer_id,
                agreed_terms=agreed_terms,
                created_at=now,
            )
            self._phase[negotiation_id] = "AGREEMENT_REACHED"
            self._conditional.pop(negotiation_id, None)
            return self._agreement_task(agreement, now)

        if action == "clarification":
            reply = env.finalize_envelope(
                {
                    "capability": env.CAPABILITY,
                    "protocol_version": env.PROTOCOL_VERSION,
                    "negotiation_id": negotiation_id,
                    "exchange_id": env.new_exchange_id(),
                    "message_id": env.new_message_id(),
                    "in_reply_to": in_reply_to,
                    "actor": "merchant",
                    "action": "clarification_response",
                    "created_at": now,
                    "payload": {
                        "type": "clarification_response",
                        "answers": [{"field": "delivery_before", "answer": f"delivery before {MERCHANT_DELIVERY_BEFORE}, payment terms negotiable (nonbinding)"}],
                    },
                }
            )
            return self._envelope_task(reply)

        if action in {"withdraw", "decline", "cancel"}:
            self._conditional.pop(negotiation_id, None)
            scope = (payload or {}).get("scope", "offer") if action != "cancel" else "negotiation"
            if action == "cancel" or scope == "negotiation":
                self._phase[negotiation_id] = {"withdraw": "WITHDRAWN", "decline": "DECLINED", "cancel": "CANCELED"}[action]
            return self._text_task(f"{action} (scope={scope}).")

        raise MerchantDecline("state_conflict", f"unhandled action {action}")

    # -- 回复构造 -----------------------------------------------------------

    def _offer_terms(self, product: dict, sku: str, quantity: int, now: str, *, override_price: int | None = None) -> dict:
        return env.offer_terms(
            sku=sku,
            quantity=quantity,
            amount_minor=override_price if override_price is not None else product["price_minor"],
            currency=MERCHANT_CURRENCY,
            delivery_before=product.get("delivery_before", MERCHANT_DELIVERY_BEFORE),
            valid_until=_valid_until(now),
            handoff_destination=product.get("handoff_destination"),
        )

    def _envelope_task(self, reply_envelope: dict) -> dict:
        return {
            "id": _task_id(),
            "contextId": _context_id(),
            "status": {
                "state": "TASK_STATE_WORKING",
                "message": {
                    "role": "agent",
                    "messageId": reply_envelope["message_id"],
                    "parts": [{"kind": "data", "data": {"knp_envelope": reply_envelope}}],
                },
            },
        }

    def _agreement_task(self, agreement: dict, now: str) -> dict:
        return {
            "id": _task_id(),
            "contextId": _context_id(),
            "status": {
                "state": "TASK_STATE_COMPLETED",
                "message": {
                    "role": "agent",
                    "messageId": env.new_message_id(),
                    "parts": [{"kind": "text", "text": "Agreement reached (nonbinding)."}],
                },
            },
            "artifacts": [
                {"artifactId": f"art_{uuid.uuid4().hex}", "parts": [{"kind": "data", "data": {"agreement": agreement}}]}
            ],
        }

    def _text_task(self, text: str) -> dict:
        return {
            "id": _task_id(),
            "contextId": _context_id(),
            "status": {
                "state": "TASK_STATE_WORKING",
                "message": {"role": "agent", "messageId": env.new_message_id(), "parts": [{"kind": "text", "text": text}]},
            },
        }


class MerchantDeclineTask:
    """把 MerchantDecline 转成 decline 回复 task。"""

    @staticmethod
    def build(reason_code: str, message: str, now: str) -> dict:
        return {
            "id": _task_id(),
            "contextId": _context_id(),
            "status": {
                "state": "TASK_STATE_COMPLETED",
                "message": {
                    "role": "agent",
                    "messageId": env.new_message_id(),
                    "parts": [
                        {
                            "kind": "data",
                            "data": {"decline": True, "reason_code": reason_code, "message": message},
                        }
                    ],
                },
            },
        }


# ---------------------------------------------------------------------------
# HTTP 层
# ---------------------------------------------------------------------------


class MerchantHTTPServer:
    """把 Merchant 相位机暴露为 A2A SendMessage 端点。"""

    def __init__(self, *, products: dict[str, dict] | None = None, now: Any | None = None) -> None:
        self.merchant = Merchant(products=products)
        self._now = now or (lambda: _utc_now_iso())
        self._requests: list[dict] = []

    def _now_value(self) -> str:
        if callable(self._now):
            return self._now()
        return self._now

    def start(self, port: int = 0) -> str:
        handler = type(
            "_Handler",
            (BaseHTTPRequestHandler,),
            {
                "do_POST": lambda self: self._fixture._handle(self),
                "do_GET": lambda self: self._fixture._handle_get(self),
                "log_message": lambda *_: None,
            },
        )
        handler._fixture = self
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.httpd.server_address
        return f"http://{host}:{port}"

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    @property
    def requests(self) -> list[dict]:
        return self._requests

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length", "0"))
        raw = handler.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json(handler, 400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            return
        self._requests.append(body)
        rpc_id = body.get("id")
        if body.get("method") != "SendMessage":
            self._send_json(
                handler, 200, {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32601, "message": "method not found"}}
            )
            return
        msg = (body.get("params") or {}).get("message") or {}
        envelope = self._extract_envelope(msg)
        if envelope is None:
            self._send_json(
                handler, 200, {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32600, "message": "missing knp_envelope"}}
            )
            return
        try:
            env.validate_envelope(envelope)
        except env.EnvelopeError as err:
            self._send_json(
                handler, 200, {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32600, "message": f"invalid envelope: {err}"}}
            )
            return
        try:
            task = self.merchant.handle_envelope(envelope, now=self._now_value())
        except MerchantDecline as err:
            task = MerchantDeclineTask.build(err.reason_code, str(err), self._now_value())
        self._send_json(handler, 200, {"jsonrpc": "2.0", "id": rpc_id, "result": {"task": task}})

    def _handle_get(self, handler: BaseHTTPRequestHandler) -> None:
        if handler.path == "/.well-known/agent-card.json":
            self._send_json(
                handler,
                200,
                {
                    "name": "Kiwi Ref Merchant",
                    "description": "Kiwi Negotiation Protocol — Python reference merchant",
                    "provider": {"organization": "kiwi-ref"},
                    "version": "1.0.0",
                    "url": self._base_url(),
                    "supportedInterfaces": [
                        {"url": f"{self._base_url()}/", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
                    ],
                    "capabilities": {"extendedAgentCard": True},
                    "skills": [],
                    "defaultInputModes": ["text"],
                    "defaultOutputModes": ["text"],
                },
            )
            return
        self._send_json(handler, 404, {"error": "not found"})

    def _base_url(self) -> str:
        host, port = self.httpd.server_address
        return f"http://{host}:{port}"

    def _extract_envelope(self, message: dict) -> dict | None:
        parts = message.get("parts")
        if not isinstance(parts, list):
            return None
        for part in parts:
            if isinstance(part, dict) and isinstance(part.get("data"), dict):
                envelope = part["data"].get("knp_envelope")
                if isinstance(envelope, dict):
                    return envelope
        return None

    def _send_json(self, handler: BaseHTTPRequestHandler, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(payload)))
        handler.end_headers()
        handler.wfile.write(payload)


def _utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
