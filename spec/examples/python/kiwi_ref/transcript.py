"""可校验 transcript：JSONL + JCS 内容寻址 + 哈希链（零 kiwi 依赖）。

镜像 Kiwi TS Ledger 的可验证性（`src/negotiation/ledger/`）：

- 每条事件内容寻址：``event_digest = sha256:<hex(JCS(业务字段))>``——同一逻辑
  内容（键序无关）得到同一 digest；
- 哈希链：每条事件的 ``previous_event_digest`` 指向同链前一条；首条为 null；
- ``verify()`` 重算每条 digest + 校验每条链连接，检出 篡改 / 断链 / 重复 /
  损坏 四类错误。

bookkeeping 字段（``event_id`` / ``event_digest`` / ``previous_event_digest`` /
``recorded_at``）不参与 digest——与 TS Ledger 一致。
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from .jcs import content_digest

_BOOKKEEPING = frozenset({"event_id", "event_digest", "previous_event_digest", "recorded_at"})


class TranscriptError(ValueError):
    """transcript 不可验证（篡改/断链/损坏）。"""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(f"transcript {kind}: {detail}")
        self.kind = kind


def event_digest(content: dict) -> str:
    """业务字段（排除 bookkeeping）的 content digest。"""
    clean = {k: v for k, v in content.items() if k not in _BOOKKEEPING}
    return content_digest(clean)


def new_event_id() -> str:
    return f"evt_{uuid.uuid4().hex}"


class Transcript:
    """追加型事件链。``append(content)`` 返回写入的事件；``verify()`` 全链校验。

    ``chain`` 是协商事件链（每条带 ``negotiation_id``）；构造后可用
    ``write_jsonl(path)`` 落地、``Transcript.load(path)`` 读回。默认追加到
    同链末尾（按 ``previous_event_digest`` 连接）。
    """

    def __init__(self) -> None:
        self.events: list[dict] = []

    def append(self, content: dict, *, chain: str | None = None) -> dict:
        """追加一条事件。``chain`` 为空时取 content.negotiation_id 作为链。"""
        chain_key = chain if chain is not None else str(content.get("negotiation_id") or "")
        previous = self._last_of(chain_key)
        event = {
            **content,
            "event_id": new_event_id(),
            "previous_event_digest": previous["event_digest"] if previous is not None else None,
            "recorded_at": content.get("occurred_at") or "",
        }
        event["event_digest"] = event_digest(event)
        self.events.append(event)
        return event

    def _last_of(self, chain: str) -> dict | None:
        for event in reversed(self.events):
            if str(event.get("negotiation_id") or "") == chain:
                return event
        return None

    def verify(self) -> None:
        """全链校验：任一事件 digest 不符 / 链连接断裂 → 抛 TranscriptError。"""
        last_digest: dict[str, str | None] = {}
        seen_digests: set[str] = set()
        for i, event in enumerate(self.events):
            recomputed = event_digest(event)
            if recomputed != event.get("event_digest"):
                raise TranscriptError("tampered", f"event #{i} digest mismatch")
            if event["event_digest"] in seen_digests:
                raise TranscriptError("duplicate", f"event #{i} digest seen before")
            seen_digests.add(event["event_digest"])
            chain = str(event.get("negotiation_id") or "")
            expected_prev = last_digest.get(chain)
            actual_prev = event.get("previous_event_digest")
            if actual_prev != expected_prev:
                raise TranscriptError(
                    "chain_break",
                    f"event #{i} previous_event_digest {actual_prev!r} != expected {expected_prev!r}",
                )
            last_digest[chain] = event["event_digest"]

    def write_jsonl(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as f:
            for event in self.events:
                f.write(json.dumps(event, ensure_ascii=False) + "\n")

    @classmethod
    def load(cls, path: str) -> "Transcript":
        transcript = cls()
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line == "":
                    continue
                try:
                    transcript.events.append(json.loads(line))
                except json.JSONDecodeError as err:
                    raise TranscriptError("corrupt", f"unparseable line: {err}") from err
        return transcript

    def to_jsonl(self) -> str:
        return "\n".join(json.dumps(e, ensure_ascii=False) for e in self.events)
