#!/usr/bin/env python3
"""Normalize Gaokao admission CSV headers into a common schema."""

from __future__ import annotations

import argparse
import csv
import re
from pathlib import Path


ALIASES = {
    "year": {"year", "年份", "录取年份"},
    "province": {"province", "省份", "招生省份"},
    "batch": {"batch", "批次"},
    "subject_track": {"subject_track", "科类", "首选科目", "类别", "文理科"},
    "school_code": {"school_code", "院校代码", "学校代码"},
    "school_name": {"school_name", "院校", "学校", "院校名称", "学校名称"},
    "major_group_code": {"major_group_code", "专业组", "院校专业组", "专业组代码"},
    "major_group_name": {"major_group_name", "专业组名称"},
    "major_code": {"major_code", "专业代码"},
    "major_name": {"major_name", "专业", "专业名称"},
    "plan_count": {"plan_count", "计划", "计划数", "招生计划"},
    "min_score": {"min_score", "最低分", "投档最低分"},
    "min_rank": {"min_rank", "最低位次", "最低排名", "投档位次", "位次"},
    "avg_score": {"avg_score", "平均分"},
    "avg_rank": {"avg_rank", "平均位次"},
    "subject_requirement": {"subject_requirement", "选科", "选考科目", "科目要求", "选科要求"},
    "tuition": {"tuition", "学费"},
    "campus": {"campus", "校区"},
    "school_type": {"school_type", "院校性质", "办学性质", "学校类型"},
    "remarks": {"remarks", "备注", "限制", "说明"},
    "source": {"source", "来源", "数据来源"},
}

NUMERIC_FIELDS = {"year", "plan_count", "min_score", "min_rank", "avg_score", "avg_rank", "tuition"}


def clean_number(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    value = re.sub(r"[,，\s]", "", value)
    match = re.search(r"-?\d+(?:\.\d+)?", value)
    return match.group(0) if match else value


def canonical_header(header: str) -> str:
    normalized = header.strip()
    for canonical, aliases in ALIASES.items():
        if normalized in aliases:
            return canonical
    return normalized


def normalize(infile: Path, outfile: Path) -> None:
    with infile.open("r", encoding="utf-8-sig", newline="") as src:
        reader = csv.DictReader(src)
        if not reader.fieldnames:
            raise SystemExit("Input CSV has no header row.")
        field_map = {name: canonical_header(name) for name in reader.fieldnames}
        output_fields = list(dict.fromkeys(field_map.values()))
        for required in ("year", "province", "subject_track", "school_name", "min_rank"):
            if required not in output_fields:
                output_fields.append(required)

        rows = []
        for row in reader:
            normalized_row = {field: "" for field in output_fields}
            for raw_key, value in row.items():
                key = field_map.get(raw_key or "", raw_key or "")
                text = (value or "").strip()
                normalized_row[key] = clean_number(text) if key in NUMERIC_FIELDS else text
            rows.append(normalized_row)

    with outfile.open("w", encoding="utf-8", newline="") as dst:
        writer = csv.DictWriter(dst, fieldnames=output_fields)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_csv", type=Path)
    parser.add_argument("output_csv", type=Path)
    args = parser.parse_args()
    normalize(args.input_csv, args.output_csv)


if __name__ == "__main__":
    main()
