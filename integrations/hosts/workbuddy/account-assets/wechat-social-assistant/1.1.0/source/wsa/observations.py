"""Structured OCR observations shared by perception and storage layers.

Coordinates are normalized to the Vision convention (0..1, origin at the
lower-left of the image).  The contract intentionally accepts a small amount
of legacy flexibility so older text-only OCR helpers can still be ingested.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from math import isfinite
from typing import Any, Iterable, Mapping


@dataclass(frozen=True)
class OCRObservation:
    text: str
    confidence: float | None = None
    bbox_x: float | None = None
    bbox_y: float | None = None
    bbox_width: float | None = None
    bbox_height: float | None = None
    source: str = "text"
    speaker_candidate: str | None = None
    speaker_confidence: float | None = None
    sequence: int | None = None

    @property
    def bbox(self) -> tuple[float, float, float, float] | None:
        values = (self.bbox_x, self.bbox_y, self.bbox_width, self.bbox_height)
        return tuple(values) if all(value is not None for value in values) else None  # type: ignore[return-value]


def normalize_observations(
    values: Iterable[OCRObservation | Mapping[str, Any]] | None,
    *,
    fallback_text: Iterable[str] | None = None,
    source: str = "text",
) -> tuple[OCRObservation, ...]:
    """Normalize external/helper values into a stable, ordered tuple."""

    if values is None:
        values = (
            OCRObservation(text=str(text), source=source)
            for text in (fallback_text or ())
            if str(text).strip()
        )

    normalized: list[OCRObservation] = []
    for index, value in enumerate(values):
        observation = value if isinstance(value, OCRObservation) else observation_from_mapping(value, source=source)
        text = observation.text.strip()
        if not text:
            continue
        normalized.append(replace(observation, text=text, sequence=index))
    return tuple(normalized)


def observation_from_mapping(value: Mapping[str, Any], *, source: str = "text") -> OCRObservation:
    text = str(value.get("text") or value.get("string") or "").strip()
    bbox = value.get("bbox") or value.get("boundingBox")
    bbox_x, bbox_y, bbox_width, bbox_height = _bbox_values(bbox)
    if bbox is None:
        bbox_x = _number_or_none(value.get("bbox_x", value.get("x")))
        bbox_y = _number_or_none(value.get("bbox_y", value.get("y")))
        bbox_width = _number_or_none(value.get("bbox_width", value.get("width")))
        bbox_height = _number_or_none(value.get("bbox_height", value.get("height")))
    return OCRObservation(
        text=text,
        confidence=_confidence_or_none(value.get("confidence")),
        bbox_x=bbox_x,
        bbox_y=bbox_y,
        bbox_width=bbox_width,
        bbox_height=bbox_height,
        source=str(value.get("source") or source),
        speaker_candidate=_optional_text(value.get("speaker_candidate")),
        speaker_confidence=_confidence_or_none(value.get("speaker_confidence")),
        sequence=_integer_or_none(value.get("sequence")),
    )


def _bbox_values(value: Any) -> tuple[float | None, float | None, float | None, float | None]:
    if isinstance(value, Mapping):
        return (
            _number_or_none(value.get("x", value.get("minX"))),
            _number_or_none(value.get("y", value.get("minY"))),
            _number_or_none(value.get("width")),
            _number_or_none(value.get("height")),
        )
    if isinstance(value, (list, tuple)) and len(value) == 4:
        return tuple(_number_or_none(item) for item in value)  # type: ignore[return-value]
    return (None, None, None, None)


def _number_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(number):
        return None
    return max(0.0, min(1.0, number))


def _confidence_or_none(value: Any) -> float | None:
    return _number_or_none(value)


def _integer_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
