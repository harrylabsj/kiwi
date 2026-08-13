"""kiwi_ref — Kiwi Negotiation Protocol 最小独立参考实现（Issue 11 / D2）。

零 Kiwi runtime 依赖、零第三方依赖（纯 Python 标准库）。与 Kiwi TS 实现
逐字节互操作：JCS digest / envelope 结构 / A2A 1.0 JSON-RPC 帧。

模块：
- jcs.py        RFC 8785 JCS + content digest
- envelope.py   KNP envelope 构造 / digest / 校验
- a2a.py        A2A 1.0 JSON-RPC client（SendMessage）
- merchant.py   最小 A2A merchant（相位机 RFQ→…→Agreement）
- conditional.py 条件求值器（all/any/leaf）
- transcript.py 可校验 JSONL transcript（内容寻址 + 哈希链）
- handoff.py    KTH HandoffCandidate（三副作用恒 false）
"""

__version__ = "1.0.0"
