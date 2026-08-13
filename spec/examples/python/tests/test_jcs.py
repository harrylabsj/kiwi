"""JCS 测试：锚定 Kiwi TS `tests/jcs.test.ts` 向量 + 跨实现 golden digest。

Golden digest 来自 `contracts/interop/knp-data-part-examples.json`（由 Kiwi
dist 生成）——本实现重算必须逐字节一致，任何偏离即证明跨实现互操作断裂。
"""

from __future__ import annotations

import json
import os
import unittest

from kiwi_ref.jcs import canonicalize, content_digest

# contract 镜像相对本文件：spec/examples/python/tests/ -> contracts/interop/
_CONTRACTS_INTEROP = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "contracts", "interop")
)
_DATA_PART_EXAMPLES = os.path.join(_CONTRACTS_INTEROP, "knp-data-part-examples.json")

NUL = chr(0)
LS = chr(0x2028)
PS = chr(0x2029)
BACKSLASH = chr(0x5C)


class CanonicalizeVectors(unittest.TestCase):
    """镜像 TS jcs.test.ts 的全部向量。"""

    def test_sorts_keys_and_normalizes_numbers(self) -> None:
        self.assertEqual(canonicalize({"b": 1, "a": "x"}), '{"a":"x","b":1}')
        self.assertEqual(canonicalize(-0.0), "-0")
        self.assertEqual(canonicalize(1e21), "1e21")
        self.assertEqual(canonicalize(1e-7), "1e-7")

    def test_preserves_u2028_u2029_literal_in_strings(self) -> None:
        self.assertEqual(canonicalize(f"a{LS}b"), f'"a{LS}b"')
        self.assertEqual(canonicalize(f"a{PS}b"), f'"a{PS}b"')

    def test_preserves_u2028_u2029_literal_in_keys(self) -> None:
        self.assertEqual(canonicalize({f"k{LS}": 1}), f'{{"k{LS}":1}}')

    def test_control_characters_escaped(self) -> None:
        self.assertEqual(canonicalize("hello\n世界"), '"hello\\n世界"')
        # 期望输出是 6 个字符的转义序列（反斜杠 + "u0000" 四字符），非真实 NUL。
        self.assertEqual(canonicalize(f"a{NUL}b"), f'"a{BACKSLASH}u0000b"')
        self.assertEqual(canonicalize("a\tb"), '"a\\tb"')

    def test_non_ascii_not_escaped(self) -> None:
        # ensure_ascii=False：CJK 字面保留。
        self.assertEqual(canonicalize("世界"), '"世界"')

    def test_null_and_bool(self) -> None:
        self.assertEqual(canonicalize(None), "null")
        self.assertEqual(canonicalize(True), "true")
        self.assertEqual(canonicalize(False), "false")
        self.assertEqual(canonicalize({"a": None}), '{"a":null}')

    def test_non_finite_rejected(self) -> None:
        with self.assertRaises(TypeError):
            canonicalize(float("nan"))
        with self.assertRaises(TypeError):
            canonicalize(float("inf"))


class GoldenEnvelopeDigests(unittest.TestCase):
    """对 Kiwi dist 生成的完整 envelope 重算 digest，必须逐字节一致。"""

    def _examples(self) -> list[dict]:
        with open(_DATA_PART_EXAMPLES, encoding="utf-8") as f:
            data = json.load(f)
        return data["examples"]

    def test_recompute_digest_of_every_interop_envelope(self) -> None:
        for example in self._examples():
            # 消息类例子为 `message.parts`；task_result 为 `task.status.message.parts`。
            carrier = example["message"] if "message" in example else example["task"]["status"]["message"]
            parts = carrier["parts"]
            envelopes = [
                part["data"]["knp_envelope"]
                for part in parts
                if isinstance(part, dict)
                and part.get("kind") == "data"
                and "knp_envelope" in part["data"]
            ]
            self.assertEqual(len(envelopes), 1, f"{example['label']}: expected one KNP envelope")
            envelope = envelopes[0]
            expected = envelope["digest"]
            recomputed = content_digest(_without_digest(envelope))
            self.assertEqual(
                recomputed,
                expected,
                f"{example['label']} digest mismatch — cross-impl interop broken",
            )


def _without_digest(envelope: dict) -> dict:
    """克隆 envelope 去掉 digest 与 transport signature 字段（KNP §19.2）。"""
    excluded = {
        "digest",
        "signature",
        "transport_signature",
        "http_message_signature",
        "x_message_signature",
    }
    return {k: v for k, v in envelope.items() if k not in excluded}


if __name__ == "__main__":
    unittest.main()
