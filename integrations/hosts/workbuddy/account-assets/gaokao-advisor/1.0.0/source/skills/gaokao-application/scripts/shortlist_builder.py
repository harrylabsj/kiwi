#!/usr/bin/env python3
"""Build a rough rank-window shortlist from normalized admission CSV."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path


def contains(value: str, needle: str | None) -> bool:
    return not needle or needle in (value or "")


def build(args: argparse.Namespace) -> None:
    lower = int(args.rank * (1 - args.window))
    upper = int(args.rank * (1 + args.window))
    with args.input_csv.open("r", encoding="utf-8-sig", newline="") as src:
        reader = csv.DictReader(src)
        fields = list(reader.fieldnames or [])
        rows = []
        for row in reader:
            if args.province and row.get("province") and args.province not in row.get("province", ""):
                continue
            if args.subject and not (
                contains(row.get("subject_track", ""), args.subject)
                or contains(row.get("subject_requirement", ""), args.subject)
            ):
                continue
            if args.batch and args.batch not in row.get("batch", ""):
                continue
            try:
                min_rank = int(float((row.get("min_rank") or "").replace(",", "")))
            except ValueError:
                continue
            if lower <= min_rank <= upper:
                rows.append(row)

    rows.sort(key=lambda r: abs(int(float(r["min_rank"])) - args.rank))
    with args.out.open("w", encoding="utf-8", newline="") as dst:
        writer = csv.DictWriter(dst, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows[: args.limit])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_csv", type=Path)
    parser.add_argument("--rank", type=int, required=True)
    parser.add_argument("--province")
    parser.add_argument("--subject")
    parser.add_argument("--batch")
    parser.add_argument("--window", type=float, default=0.35)
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--out", type=Path, required=True)
    build(parser.parse_args())


if __name__ == "__main__":
    main()
