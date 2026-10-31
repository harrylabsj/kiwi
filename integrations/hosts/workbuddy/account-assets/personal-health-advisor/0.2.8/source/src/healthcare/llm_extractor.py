"""Vision-LLM extraction adapter for low-quality report images.

Some real reports (mobile-app screenshots, blurry photos) defeat the
deterministic parser. This adapter sends the image to a configured LLM with a
constrained structured-extraction prompt and returns the extracted fields as
candidates.

Safety contract (RFC 11.6, 7.3):
- Sending health data to a remote model is a data-egress event: callers must
  pass explicit consent; the CLI refuses without ``--consent-remote``.
- The prompt is extraction-only (structured JSON, no tools, no diagnosis).
- The returned fields are *candidates*: the Control review flow confirms them.
  They are never auto-confirmed.
- The API key is read from ``HEALTHCARE_LLM_API_KEY`` (git-ignored), never
  from arguments or committed config.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .parser import _TEXT_FIELD_PATTERNS, _FIELD_PATTERNS, fold_unit_equivalent

# field -> canonical unit, for the extraction prompt and result validation.
SUPPORTED_FIELDS: dict[str, str | None] = {
    **{field: unit for field, _, unit in _FIELD_PATTERNS},
    **{field: None for field, _ in _TEXT_FIELD_PATTERNS},
    "height_cm": "cm",
    "weight_kg": "kg",
    "bmi": "kg/m²",
}

DEFAULT_ENDPOINT = os.environ.get("HEALTHCARE_LLM_ENDPOINT", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")
DEFAULT_MODEL = os.environ.get("HEALTHCARE_LLM_MODEL", "qwen-vl-max")


class LlmExtractionError(RuntimeError):
    """The LLM adapter could not extract or validate the requested fields."""


@dataclass(frozen=True, slots=True)
class LlmField:
    field: str
    value: float | str
    unit: str | None
    raw_value: str
    confidence: float = 0.9
    value_type: str = "numeric"
    # Preserve the source unit even when it is not safe to normalize. `unit`
    # is only the canonical, comparable unit.
    raw_unit: str | None = None


def build_extraction_prompt() -> str:
    """Constrained, extraction-only prompt; never asks for interpretation."""
    fields = {name: unit for name, unit in SUPPORTED_FIELDS.items()}
    return (
        "你是健康检验报告的字段提取器。你只能从图片中提取检验数值，不能诊断、不能建议、"
        "不能调用任何工具，也不能输出图片以外的任何推测。\n"
        "从图片中提取以下检验项目的数值。对每个项目返回一个对象：\n"
        '{"field": "项目名", "value": 数值(数字)或文本(如 阴性/阳性), "unit": "单位或null", "raw_value": "图中的原文"}\n'
        "项目与规范单位：\n"
        + json.dumps(fields, ensure_ascii=False, indent=1)
        + "\n规则：\n"
        "- 只输出一个 JSON 数组，不要任何其他文字或代码块标记。\n"
        "- 图中没有的项目不要返回。\n"
        "- 数值不清晰或无法确定时该项目的 value 用 null。\n"
        "- 单位写成图中原文；若原文单位与规范单位不同，仍保留原文并原样报告。\n"
        "- 若返回的项目不在上面的列表中，或格式不对，整个结果无效。"
    )


def _image_data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(str(path))[0] or "image/png"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def extract_image(
    image_path: Path,
    *,
    endpoint: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
) -> list[LlmField]:
    """Send one image to the LLM and return validated extracted fields.

    ``api_key`` defaults to ``HEALTHCARE_LLM_API_KEY``. The HTTP call is the
    only network access in this module and only happens on explicit request.
    """
    key = api_key or os.environ.get("HEALTHCARE_LLM_API_KEY")
    if not key:
        raise LlmExtractionError("HEALTHCARE_LLM_API_KEY is not set")
    body = {
        "model": model or DEFAULT_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": build_extraction_prompt()},
                    {"type": "image_url", "image_url": {"url": _image_data_uri(image_path)}},
                ],
            }
        ],
        "temperature": 1,  # Kimi's kimi-for-coding only accepts temperature=1
    }
    request = urllib.request.Request(
        endpoint or DEFAULT_ENDPOINT,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise LlmExtractionError(f"LLM request failed: {exc}") from exc
    try:
        content = payload["choices"][0]["message"]["content"]
        raw_items = json.loads(content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise LlmExtractionError("LLM returned an unusable response") from exc
    if not isinstance(raw_items, list):
        raise LlmExtractionError("LLM response is not a JSON array")
    return [_validate_item(item) for item in raw_items]


def _validate_item(item: Any) -> LlmField:
    if not isinstance(item, dict):
        raise LlmExtractionError("LLM returned a non-object field")
    field = str(item.get("field", "")).strip()
    if field not in SUPPORTED_FIELDS:
        raise LlmExtractionError(f"LLM returned unknown field: {field}")
    raw_value = str(item.get("raw_value", "")).strip()
    value: float | str
    value_type = "numeric"
    raw = item.get("value")
    if isinstance(raw, (int, float)):
        value = float(raw)
    elif isinstance(raw, str) and raw.strip():
        value = raw.strip()
        value_type = "text"
    else:
        raise LlmExtractionError(f"LLM returned no usable value for {field}")
    unit = item.get("unit")
    raw_unit: str | None = None
    canonical = SUPPORTED_FIELDS[field]
    if unit is None or not str(unit).strip():
        unit = None
    else:
        unit = str(unit).strip()
        raw_unit = unit
        # A unit that does not fold-match the canonical stays unmapped: the
        # candidate carries the raw unit and the Control review must correct it.
        if canonical is not None and not fold_unit_equivalent(unit) == fold_unit_equivalent(canonical):
            unit = None
    if value_type == "text" and unit is not None:
        unit = None
    return LlmField(
        field=field,
        value=value,
        unit=unit,
        raw_value=raw_value,
        value_type=value_type,
        raw_unit=raw_unit,
    )
