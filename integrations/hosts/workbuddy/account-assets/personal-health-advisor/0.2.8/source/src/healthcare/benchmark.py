from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .parser import ParsedField, fold_unit_equivalent, parse_report


@dataclass(frozen=True, slots=True)
class GoldenField:
    field: str
    value: float = 0.0
    unit: str | None = None
    raw_unit: str | None = None
    raw_comparator: str | None = None
    precision: int | None = None
    value_type: str = "numeric"
    text_value: str | None = None


@dataclass(frozen=True, slots=True)
class GoldenCase:
    case_id: str
    source: str | None
    expected: tuple[GoldenField, ...]
    text: str | None = None
    split: str = "exploration"
    layout: str | None = None
    annotators: tuple[str, ...] | None = None
    adjudicated: bool = False


@dataclass(frozen=True, slots=True)
class CaseResult:
    case_id: str
    split: str
    expected_fields: int
    parsed_fields: int
    exact_fields: int
    missing_fields: tuple[str, ...]
    unexpected_fields: tuple[str, ...]
    mismatches: tuple[str, ...]

    @property
    def passed(self) -> bool:
        return not self.missing_fields and not self.unexpected_fields and not self.mismatches


def load_cases(path: Path) -> tuple[GoldenCase, ...]:
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("format") != "healthCare.golden-benchmark" or document.get("version") != 1:
        raise ValueError("unsupported golden benchmark format")
    cases: list[GoldenCase] = []
    for raw_case in document.get("cases", []):
        source = raw_case.get("fixture")
        inline_text = raw_case.get("text")
        if not isinstance(source, str) and not isinstance(inline_text, str):
            raise ValueError("golden case requires a fixture path or inline text")
        expected = tuple(GoldenField(**field) for field in raw_case.get("expected", []))
        annotators = raw_case.get("annotators")
        cases.append(
            GoldenCase(
                case_id=str(raw_case["id"]),
                source=str((path.parent / source).resolve()) if isinstance(source, str) else None,
                expected=expected,
                text=inline_text if isinstance(inline_text, str) else None,
                split=str(raw_case.get("split", "exploration")),
                layout=raw_case.get("layout"),
                annotators=tuple(annotators) if isinstance(annotators, list) else None,
                adjudicated=bool(raw_case.get("adjudicated", False)),
            )
        )
    if not cases:
        raise ValueError("golden benchmark must contain at least one case")
    return tuple(cases)


def _compare(expected: GoldenField, actual: ParsedField) -> list[str]:
    mismatches: list[str] = []
    if expected.value_type == "text":
        if actual.value_type != "text" or actual.text_value != expected.text_value:
            mismatches.append(
                f"{expected.field}.text_value expected={expected.text_value!r} actual={actual.text_value!r}"
            )
        return mismatches
    if actual.value != expected.value:
        mismatches.append(f"{expected.field}.value expected={expected.value} actual={actual.value}")
    # Unit comparisons fold glyph-equivalent variants (μ->u, superscripts->
    # digits): OCR flattens mL/min/1.73m² to mL/min/1.73m2 without changing
    # the unit. A genuine cross-dimension difference still mismatches.
    if fold_unit_equivalent(actual.unit or "") != fold_unit_equivalent(expected.unit or ""):
        mismatches.append(f"{expected.field}.unit expected={expected.unit!r} actual={actual.unit!r}")
    if expected.raw_unit is not None and fold_unit_equivalent(actual.raw_unit or "") != fold_unit_equivalent(expected.raw_unit):
        mismatches.append(f"{expected.field}.raw_unit expected={expected.raw_unit!r} actual={actual.raw_unit!r}")
    if expected.raw_comparator is not None and actual.raw_comparator != expected.raw_comparator:
        mismatches.append(
            f"{expected.field}.raw_comparator expected={expected.raw_comparator!r} actual={actual.raw_comparator!r}"
        )
    if expected.precision is not None and actual.precision != expected.precision:
        mismatches.append(f"{expected.field}.precision expected={expected.precision} actual={actual.precision}")
    return mismatches


def evaluate_case(case: GoldenCase) -> CaseResult:
    text = case.text if case.text is not None else Path(case.source or "").read_text(encoding="utf-8")
    parsed = parse_report(text)
    expected_by_field = {field.field: field for field in case.expected}
    actual_by_field = {field.field: field for field in parsed}
    missing = tuple(sorted(set(expected_by_field) - set(actual_by_field)))
    unexpected = tuple(sorted(set(actual_by_field) - set(expected_by_field)))
    mismatches = tuple(
        mismatch
        for field_name in sorted(set(expected_by_field) & set(actual_by_field))
        for mismatch in _compare(expected_by_field[field_name], actual_by_field[field_name])
    )
    exact = len(expected_by_field) - len(missing) - sum(
        1 for field_name in expected_by_field if field_name in actual_by_field and any(field_name in item for item in mismatches)
    )
    return CaseResult(
        case_id=case.case_id,
        split=case.split,
        expected_fields=len(expected_by_field),
        parsed_fields=len(actual_by_field),
        exact_fields=max(0, exact),
        missing_fields=missing,
        unexpected_fields=unexpected,
        mismatches=mismatches,
    )


_ERROR_CLASSES = (
    "missing_field",
    "unexpected_field",
    "value",
    "unit",
    "raw_unit",
    "raw_comparator",
    "precision",
    "other",
)


def _error_classes(result: CaseResult) -> set[str]:
    """Classify a failed case into the Phase 0A error taxonomy buckets."""
    classes: set[str] = set()
    if result.missing_fields:
        classes.add("missing_field")
    if result.unexpected_fields:
        classes.add("unexpected_field")
    for mismatch in result.mismatches:
        if ".value " in mismatch:
            classes.add("value")
        elif ".unit " in mismatch:
            classes.add("unit")
        elif ".raw_unit " in mismatch:
            classes.add("raw_unit")
        elif ".raw_comparator " in mismatch:
            classes.add("raw_comparator")
        elif ".precision " in mismatch:
            classes.add("precision")
        else:
            classes.add("other")
    return classes


def run_benchmark(path: Path) -> dict[str, Any]:
    cases = load_cases(path)
    results = [evaluate_case(case) for case in cases]
    expected = sum(result.expected_fields for result in results)
    parsed = sum(result.parsed_fields for result in results)
    exact = sum(result.exact_fields for result in results)
    return {
        "format": "healthCare.golden-benchmark-result",
        "version": 1,
        "benchmark": str(path),
        "cases": [asdict(result) | {"passed": result.passed} for result in results],
        "summary": {
            "case_count": len(results),
            "passed_cases": sum(result.passed for result in results),
            "expected_fields": expected,
            "parsed_fields": parsed,
            "exact_fields": exact,
            "field_recall": exact / expected if expected else 0.0,
            "field_precision": exact / parsed if parsed else 0.0,
            "splits": {
                split: {
                    "case_count": sum(result.split == split for result in results),
                    "passed_cases": sum(result.split == split and result.passed for result in results),
                    "expected_fields": sum(result.expected_fields for result in results if result.split == split),
                    "exact_fields": sum(result.exact_fields for result in results if result.split == split),
                }
                for split in sorted({result.split for result in results})
            },
            "error_taxonomy": {
                label: sum(label in _error_classes(result) for result in results) for label in _ERROR_CLASSES
            },
            "annotated_cases": sum(bool(case.annotators) for case in cases),
            "adjudicated_cases": sum(case.adjudicated for case in cases),
        },
    }
