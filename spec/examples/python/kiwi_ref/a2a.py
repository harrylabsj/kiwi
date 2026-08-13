"""A2A 1.0 JSON-RPC client（SendMessage）— 零 kiwi 依赖，纯标准库。

镜像 Kiwi TS `src/a2a/client/client.ts` 的 wire 形状：

- POST ``<a2aPath>``，头 ``A2A-Version: 1.0`` + ``A2A-Extensions: <origin>/a2a/extensions/negotiation/1.0``
  + ``Content-Type: application/json``；
- 请求 body ``{jsonrpc, id, method: "SendMessage", params: {message: {role, messageId, parts}}}``；
- KNP DataPart 用 1.0 统一 Part：``{data: {knp_envelope}, mediaType: "application/json"}``；
- 响应 ``result.task``：回复 envelope 在 ``task.status.message.parts[].data.knp_envelope``
  （即使 1.0 请求，响应 parts 仍是 0.3 形状 ``{kind:"data",...}``——提取器不依赖 kind），
  agreement 在 ``task.artifacts[].parts[].data.agreement``。

fail-closed：非 2xx / JSON-RPC error / 缺失 task 一律抛类型化异常。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from .envelope import EnvelopeError, validate_envelope

KNP_EXTENSION_PATH = "/a2a/extensions/negotiation/1.0"
A2A_VERSION = "1.0"

SEND_MESSAGE = "SendMessage"


class A2AClientError(RuntimeError):
    """A2A wire / 协议错误。"""


class A2ABusinessDecline(A2AClientError):
    """商家业务拒绝（decline envelope：offer_unknown / terms_digest_mismatch 等）。"""

    def __init__(self, reason_code: str, message: str) -> None:
        super().__init__(f"business decline ({reason_code}): {message}")
        self.reason_code = reason_code


def _url_join(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path.lstrip("/")


def _post_json(url: str, payload: dict, headers: dict[str, str]) -> dict:
    """POST JSON 并解析响应。非 2xx / 非 JSON 一律抛错。"""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            raw = res.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        raise A2AClientError(f"HTTP {err.code} from {url}: {err.read().decode('utf-8', 'replace')[:300]}") from err
    except urllib.error.URLError as err:
        raise A2AClientError(f"request to {url} failed: {err.reason}") from err
    try:
        body = json.loads(raw)
    except json.JSONDecodeError as err:
        raise A2AClientError(f"non-JSON response from {url}: {raw[:200]}") from err
    if not isinstance(body, dict):
        raise A2AClientError("response is not a JSON object")
    if "error" in body:
        err = body["error"]
        code = err.get("code") if isinstance(err, dict) else None
        message = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        raise A2AClientError(f"JSON-RPC error {code}: {message}")
    return body


class A2AClient:
    """指向单个 A2A 端点的最小客户端。"""

    def __init__(self, url: str, *, knp_extension_path: str = KNP_EXTENSION_PATH) -> None:
        self.url = url.rstrip("/")
        parsed = urllib.parse.urlparse(self.url)
        self._extension = f"{parsed.scheme}://{parsed.netloc}{knp_extension_path}"

    # -- 发现 -------------------------------------------------------------

    def fetch_agent_card(self) -> dict:
        card_url = _url_join(self.url, "/.well-known/agent-card.json")
        try:
            with urllib.request.urlopen(card_url, timeout=15) as res:
                raw = res.read().decode("utf-8")
        except urllib.error.URLError as err:
            raise A2AClientError(f"agent card fetch failed: {err.reason}") from err
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise A2AClientError("agent card is not a JSON object")
        return body

    # -- 发送 -------------------------------------------------------------

    def send_envelope(self, envelope: dict, *, text: str | None = None) -> dict:
        """发送 KNP envelope，返回解析后的 task（含回复 envelope / agreement）。"""
        validate_envelope(envelope)
        parts: list[dict] = []
        if text is not None:
            parts.append({"text": text})
        parts.append({"data": {"knp_envelope": envelope}, "mediaType": "application/json"})
        message: dict[str, Any] = {
            "role": "agent",
            "messageId": envelope["message_id"],
            "parts": parts,
        }
        payload = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": SEND_MESSAGE,
            "params": {"message": message},
        }
        body = _post_json(self.url, payload, headers={"A2A-Version": A2A_VERSION, "A2A-Extensions": self._extension})
        result = body.get("result")
        if not isinstance(result, dict) or "task" not in result:
            raise A2AClientError("SendMessage response has no result.task")
        return result["task"]


# ---------------------------------------------------------------------------
# 响应提取
# ---------------------------------------------------------------------------


def extract_reply_envelope(task: dict) -> dict | None:
    """从 task 提取商家回复 envelope（``status.message.parts[].data.knp_envelope``）。

    parts 可能是 0.3 形状（``{kind:"data", data:{...}}``）——提取不依赖 kind。
    """
    message = (task.get("status") or {}).get("message")
    if not isinstance(message, dict):
        return None
    parts = message.get("parts")
    if not isinstance(parts, list):
        return None
    for part in parts:
        if isinstance(part, dict) and isinstance(part.get("data"), dict):
            envelope = part["data"].get("knp_envelope")
            if isinstance(envelope, dict):
                return envelope
    return None


def extract_agreement(task: dict) -> dict | None:
    """从 task.artifacts 提取 AcceptedNonbindingAgreement artifact。"""
    artifacts = task.get("artifacts")
    if not isinstance(artifacts, list):
        return None
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        parts = artifact.get("parts")
        if not isinstance(parts, list):
            continue
        for part in parts:
            if isinstance(part, dict) and isinstance(part.get("data"), dict):
                agreement = part["data"].get("agreement")
                if isinstance(agreement, dict):
                    return agreement
    return None


def extract_decline(task: dict) -> dict | None:
    """从 task 提取商业拒绝（``data.decline`` + reason_code）。"""
    message = (task.get("status") or {}).get("message")
    if not isinstance(message, dict):
        return None
    parts = message.get("parts")
    if not isinstance(parts, list):
        return None
    for part in parts:
        if isinstance(part, dict) and isinstance(part.get("data"), dict):
            data = part["data"]
            if data.get("decline") is True:
                return data
    return None


def assert_reply_digest(envelope: dict) -> None:
    """回复 envelope 必须通过 digest 校验，否则 fail-closed。"""
    validate_envelope(envelope)


def decline_or_envelope(task: dict) -> dict:
    """业务拒绝 → 抛 A2ABusinessDecline；否则返回校验后的回复 envelope。"""
    decline = extract_decline(task)
    if decline is not None:
        raise A2ABusinessDecline(
            str(decline.get("reason_code", "declined")),
            str(decline.get("message", "")),
        )
    reply = extract_reply_envelope(task)
    if reply is None:
        raise A2AClientError("task carries neither reply envelope nor decline")
    try:
        validate_envelope(reply)
    except EnvelopeError as err:
        raise A2AClientError(f"reply envelope invalid: {err}") from err
    return reply
