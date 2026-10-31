#!/usr/bin/env python3
"""Print admission records near a student's rank."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_csv", type=Path)
    parser.add_argument("--rank", type=int, required=True)
    parser.add_argument("--window", type=float, default=0.2)
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()

    rows = []
    low = int(args.rank * (1 - args.window))
    high = int(args.rank * (1 + args.window))
    with args.input_csv.open("r", encoding="utf-8-sig", newline="") as src:
        for row in csv.DictReader(src):
            try:
                min_rank = int(float((row.get("min_rank") or "").replace(",", "")))
            except ValueError:
                continue
            if low <= min_rank <= high:
                rows.append((abs(min_rank - args.rank), row))

    for _, row in sorted(rows, key=lambda item: item[0])[: args.limit]:
        school = row.get("school_name", "")
        group = row.get("major_group_code", "")
        major = row.get("major_name", "")
        min_rank = row.get("min_rank", "")
        min_score = row.get("min_score", "")
        print(f"{school}\t{group}\t{major}\tmin_rank={min_rank}\tmin_score={min_score}")


if __name__ == "__main__":
    main()
