from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True, slots=True)
class ParsedField:
    field: str
    raw_value: str
    value: float
    unit: str | None
    confidence: float
    source_line: str
    locator: str
    raw_unit: str | None = None
    reference_range_original: str | None = None
    raw_comparator: str | None = None
    precision: int | None = None
    mapping_status: str = "mapped"
    value_type: str = "numeric"
    text_value: str | None = None


_FIELD_PATTERNS: tuple[tuple[str, tuple[str, ...], str], ...] = (
    ("creatinine", ("肌酐", "血肌酐", "Scr", "CREA", "Creatinine"), "umol/L"),
    ("egfr", ("eGFR", "EGFR", "估算肾小球滤过率", "肾小球滤过率"), "mL/min/1.73m²"),
    ("uacr", ("uACR", "UACR", "尿白蛋白/肌酐", "尿白蛋白肌酐比", "尿微量白蛋白/肌酐", "MA/UCREA比值", "MA/UCREA"), "mg/g"),
    ("ualb", ("尿微量白蛋白",), "mg/L"),
    ("ucrea", ("尿肌酐",), "mmol/L"),
    ("a1m", ("尿α1-微球蛋白",), "mg/L"),
    ("utrf", ("尿转铁蛋白",), "mg/L"),
    ("uigu", ("尿免疫球蛋白",), "mg/L"),
    ("nag", ("NAG酶",), "U/L"),
    ("igg", ("免疫球蛋白G", "IgG"), "g/L"),
    ("iga", ("免疫球蛋白A", "IgA"), "g/L"),
    ("igm", ("免疫球蛋白M", "IgM"), "g/L"),
    ("c3", ("补体C3", "C3"), "g/L"),
    ("c4", ("补体C4", "C4"), "g/L"),
    ("potassium", ("血钾", "K+", "Potassium"), "mmol/L"),
    ("hemoglobin", ("血红蛋白", "Hb", "HGB", "Hemoglobin"), "g/dL"),
    ("wbc", ("白细胞计数", "WBC"), "10^9/L"),
    ("rbc", ("红细胞计数", "RBC"), "10^12/L"),
    ("hct", ("红细胞比容", "HCT"), "%"),
    ("plt", ("血小板计数", "PLT"), "10^9/L"),
    ("fpg", ("空腹血糖", "GLU-0h", "GLU"), "mmol/L"),
    ("bun", ("尿素氮", "尿素", "BUN"), "mmol/L"),
    ("ua", ("血清尿酸", "UA"), "umol/L"),
)

# Qualitative (text-valued) fields: the vasculitis antibody panel reports
# 阴性/阳性 rather than a number.
_TEXT_FIELD_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("anca", ("抗中性粒细胞胞浆抗体", "ANCA")),
    ("pr3", ("抗蛋白酶3", "PR3")),
    ("mpo", ("抗髓过氧化物酶", "MPO")),
    ("gbm", ("抗肾小球基底膜抗体", "GBM")),
)

_QUALITATIVE_TOKEN = re.compile(r"阴性|阳性|弱阳性|可疑|未检出")

_BP_LABELS = ("血压", "BP", "blood pressure")

# A label must not be the tail of a longer label ("血肌酐", "尿白蛋白/肌酐",
# "估算肾小球滤过率"); the left boundary rejects adjacent word characters.
_LABEL_BOUNDARY = r"(?<![A-Za-z0-9一-鿿/])"

_NUMBER = re.compile(r"[<>]?[0-9]+(?:[.,][0-9]+)?")

# A number directly followed by separator + number opens a reference range
# pair ("44-133", "0.6~1.2") and is not the measured value.
_RANGE_OPEN = re.compile(r"\s*[-~～]\s*[<>]?[0-9]")

# How far after a label a measured value may appear on the same line.
_VALUE_WINDOW = 48

# OCR and handwritten reports frequently flatten typographic glyphs: micro is
# written u, the superscript exponent in mL/min/1.73m² is read as a plain 2,
# and the full-width square-metre ㎡ (U+33A1) replaces "m²". These are the
# same unit written differently, not a different unit. Case is folded too:
# "ml" and "mL" are the same unit in the narrow supported set.
_GLYPH_FOLDS = str.maketrans(
    {
        "μ": "u",
        "µ": "u",
        "⁰": "0",
        "¹": "1",
        "²": "2",
        "³": "3",
        "⁴": "4",
        "⁵": "5",
        "⁶": "6",
        "⁷": "7",
        "⁸": "8",
        "⁹": "9",
    }
)


def fold_unit_equivalent(unit: str) -> str:
    """Fold visually-equivalent glyphs so unit comparison ignores typography."""
    return unit.translate(_GLYPH_FOLDS).replace("㎡", "m2").casefold()


# Known unit spellings for the supported fields, longest first. Table layouts
# put the unit in a later column, so the parser reads it from anywhere after
# the value on the same line rather than requiring it to be adjacent.
_UNIT_TOKEN = re.compile(
    r"(?:mL?/min/1\.73\s*(?:m?[㎡²]|m2)?|mL?/min/1\.7\b|[μµu]mol/L|mmol/L|mg/g|mg/dL|mg/L|g/dL|g/L|mmHg|U/L|10\^9/L|10\^12/L|%)",
    re.IGNORECASE,
)


def _label_position(label: str, line: str) -> int | None:
    match = re.search(rf"(?i){_LABEL_BOUNDARY}{re.escape(label)}", line)
    return match.end() if match else None


def _value_after(label: str, line: str) -> tuple[str, float, int] | None:
    """First standalone number after the label on this line.

    Returns ``(raw, value, label_start)``. Numbers that open a reference-range
    pair are skipped so both "肌酐 88.4 (44-133)" and
    "肌酐(参考范围:44-133) 88.4" yield 88.4.
    """
    label_end = _label_position(label, line)
    if label_end is None:
        return None
    label_start = label_end - len(label)
    window = line[label_end : label_end + _VALUE_WINDOW]
    # Parenthesized abbreviations (尿α1-微球蛋白(A1M), 肌酐(CREA)) and ranges
    # contain digits that are not the measured value; drop them before scanning.
    window = re.sub(r"\([^)]*\)", " ", window)
    skip_until = -1
    for match in _NUMBER.finditer(window):
        if match.start() < skip_until:
            continue
        # Digits embedded in an identifier token (GLU-0h, A1M, WBC7) are not
        # measured values.
        before = window[match.start() - 1] if match.start() > 0 else " "
        after = window[match.end() : match.end() + 1] or " "
        if before.isalnum() or after.isalnum():
            continue
        rest = window[match.end() :]
        # A value is normally followed soon by its unit. A unit like "10^9/L"
        # begins with a digit and would otherwise be misread as a
        # reference-range bound ("7.73 - 10^9/L"), so a unit in the next 20
        # characters marks this number as the measured value.
        if _UNIT_TOKEN.search(rest[:20]) is not None:
            raw = match.group(0)
            numeric = raw.lstrip("<>").replace(",", ".")
            try:
                return raw, float(numeric), label_start
            except ValueError:
                continue
        range_open = _RANGE_OPEN.match(rest)
        if range_open is not None:
            closing = _NUMBER.search(window, match.end() + range_open.end())
            if closing is not None:
                skip_until = closing.end()
            continue
        raw = match.group(0)
        numeric = raw.lstrip("<>").replace(",", ".")
        try:
            return raw, float(numeric), label_start
        except ValueError:
            continue
    return None


# Every label across all supported fields, used to resolve prefix collisions:
# "尿微量白蛋白" must not also claim the row "尿微量白蛋白/肌酐" (the uACR
# ratio). The longest label starting at a position wins.
_FIELD_LABELS: dict[str, tuple[str, ...]] = {
    **{field: labels for field, labels, _ in _FIELD_PATTERNS},
    **{field: labels for field, labels in _TEXT_FIELD_PATTERNS},
}


def _text_value_after(label: str, line: str) -> tuple[str, str, int] | None:
    """First qualitative token (阴性/阳性/...) after the label on this line.

    Returns ``(text_value, raw, label_start)`` for text-valued fields.
    """
    label_end = _label_position(label, line)
    if label_end is None:
        return None
    label_start = label_end - len(label)
    window = re.sub(r"\([^)]*\)", " ", line[label_end : label_end + _VALUE_WINDOW])
    match = _QUALITATIVE_TOKEN.search(window)
    if match is None:
        return None
    return match.group(0), match.group(0), label_start


def _longer_label_at(line: str, start: int, label: str) -> bool:
    """True if a longer known label also starts at this exact position."""
    for other_labels in _FIELD_LABELS.values():
        for other in other_labels:
            if len(other) <= len(label):
                continue
            if line[start : start + len(other)].casefold() == other.casefold():
                return True
    return False


def _line_for_labels(text: str, labels: tuple[str, ...]) -> tuple[str, str]:
    for index, line in enumerate(text.splitlines(), start=1):
        for label in labels:
            if _label_position(label, line) is not None:
                return line.strip(), f"line:{index}"
    return labels[0], "line:unknown"


def _field_metadata(line: str, raw: str, default_unit: str) -> tuple[str, str | None, str | None, int | None]:
    """Capture source notation without pretending it is medically normalized.

    The unit is read from anywhere after the value on the same line (table
    layouts put it in a later column). A line with no unit stays ``None`` and
    maps ``unmapped``; the parser never assumes the canonical unit, so a g/L
    value can never silently become a g/dL observation.
    """
    value_match = re.search(re.escape(raw), line)
    unit_match = _UNIT_TOKEN.search(line, value_match.end() if value_match else 0)
    raw_unit = unit_match.group(0) if unit_match else None
    reference = re.search(
        r"(?:参考(?:范围|区间)|ref(?:erence)?\s*range)\s*[:：]?\s*([^\s,，;；]+(?:\s*[-~～]\s*[^\s,，;；]+)?)",
        line,
        re.IGNORECASE,
    )
    comparator = raw[0] if raw[:1] in {"<", ">"} else None
    numeric = raw.lstrip("<>").replace(",", ".")
    precision = len(numeric.split(".", 1)[1]) if "." in numeric else 0
    return raw_unit, reference.group(1) if reference else None, comparator, precision


def _units_match(raw_unit: str, canonical_unit: str) -> bool:
    """Compare units after folding visually equivalent glyph variants.

    ``μmol/L`` and ``umol/L``, or ``mL/min/1.73m²`` and ``mL/min/1.73m2``,
    are the same unit written differently; mg/dL versus umol/L is a genuine
    cross-dimension difference and stays unmapped.
    """
    return fold_unit_equivalent(raw_unit) == fold_unit_equivalent(canonical_unit)


def parse_report(text: str) -> list[ParsedField]:
    """Parse the narrow Phase 0A numeric Chinese lab format.

    A label and its value must share one line. This parser only creates
    candidates. It never writes a confirmed observation.
    """
    parsed: list[ParsedField] = []
    seen: set[str] = set()
    lines = text.splitlines()
    for field, labels, unit in _FIELD_PATTERNS:
        for label in labels:
            found: tuple[tuple[str, float], str, int] | None = None
            for index, line in enumerate(lines, start=1):
                result = _value_after(label, line)
                if result is not None:
                    raw, value, label_start = result
                    if _longer_label_at(line, label_start, label):
                        continue
                    found = ((raw, value), line.strip(), index)
                    break
            if found is None:
                continue
            (raw, value), source_line, line_number = found
            raw_unit, reference, comparator, precision = _field_metadata(source_line, raw, unit)
            mapping_status = "mapped" if raw_unit is not None and _units_match(raw_unit, unit) else "unmapped"
            parsed.append(
                ParsedField(
                    field,
                    raw,
                    value,
                    unit if mapping_status == "mapped" else None,
                    0.98 if mapping_status == "mapped" else 0.0,
                    source_line,
                    f"line:{line_number}",
                    raw_unit,
                    reference,
                    comparator,
                    precision,
                    mapping_status,
                )
            )
            seen.add(field)
            break

    for field, labels in _TEXT_FIELD_PATTERNS:
        if field in seen:
            continue
        for label in labels:
            found: tuple[str, str, int] | None = None
            for index, line in enumerate(lines, start=1):
                result = _text_value_after(label, line)
                if result is not None:
                    text, raw, label_start = result
                    if _longer_label_at(line, label_start, label):
                        continue
                    found = (text, line.strip(), index)
                    break
            if found is None:
                continue
            text, source_line, line_number = found
            parsed.append(
                ParsedField(
                    field=field,
                    raw_value=text,
                    value=0.0,
                    unit=None,
                    confidence=0.99,
                    source_line=source_line,
                    locator=f"line:{line_number}",
                    mapping_status="mapped",
                    value_type="text",
                    text_value=text,
                )
            )
            seen.add(field)
            break

    bp = re.search(
        r"(?i)(?:血压|BP|blood pressure)[^0-9]{0,16}([0-9]{2,3})\s*/\s*([0-9]{2,3})",
        text,
    )
    if bp:
        line, locator = _line_for_labels(text, _BP_LABELS)
        systolic_raw, diastolic_raw = bp.group(1), bp.group(2)
        parsed.extend(
            [
                ParsedField("systolic_bp", systolic_raw, float(systolic_raw), "mmHg", 0.99, line, locator, "mmHg", None, None, 0),
                ParsedField("diastolic_bp", diastolic_raw, float(diastolic_raw), "mmHg", 0.99, line, locator, "mmHg", None, None, 0),
            ]
        )
    return parsed


def parse_report_date(text: str, fallback: str) -> str:
    match = re.search(r"\b(20\d{2})[-年](\d{1,2})[-月](\d{1,3})日?\b", text)
    if not match:
        return fallback
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3))).isoformat()
    except ValueError:
        # An impossible date (2026年13月5日) is treated like a missing one:
        # fall back to the import date instead of crashing the import.
        return fallback
