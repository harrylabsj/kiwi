#!/usr/bin/env python3
"""Validate a normalized Gaokao admissions CSV."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

REQUIRED = {"school_name", "min_rank"}
RECOMMENDED = {"year", "province", "batch", "subject_track", "min_score", "subject_requirement"}


def is_int(value: str) -> bool:
    try:
        int(float(value))
        return True
    except (TypeError, ValueError):
        return False


def validate(path: Path) -> int:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fields = set(reader.fieldnames or [])
        missing_required = sorted(REQUIRED - fields)
        missing_recommended = sorted(RECOMMENDED - fields)
        errors = []
        warnings = []

        if missing_required:
            errors.append(f"Missing required columns: {', '.join(missing_required)}")
        if missing_recommended:
            warnings.append(f"Missing recommended columns: {', '.join(missing_recommended)}")

        row_count = 0
        for index, row in enumerate(reader, start=2):
            row_count += 1
            if not (row.get("school_name") or "").strip():
                errors.append(f"Row {index}: missing school_name")
            rank = (row.get("min_rank") or "").strip()
            if rank and not is_int(rank):
                errors.append(f"Row {index}: min_rank is not numeric: {rank}")
            score = (row.get("min_score") or "").strip()
            if score and not is_int(score):
                warnings.append(f"Row {index}: min_score is not numeric: {score}")

    print(f"rows={row_count}")
    for warning in warnings:
        print(f"WARNING: {warning}")
    for error in errors:
        print(f"ERROR: {error}")
    return 1 if errors else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path)
    args = parser.parse_args()
    raise SystemExit(validate(args.csv_path))


if __name__ == "__main__":
    main()
