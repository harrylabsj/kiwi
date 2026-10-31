#!/usr/bin/env python3
"""Add rank-gap risk bands to a Gaokao shortlist CSV."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path


def band_for(student_rank: int, min_rank: int) -> tuple[str, float]:
    gap_ratio = (min_rank - student_rank) / student_rank
    if gap_ratio < -0.05:
        return "冲", gap_ratio
    if gap_ratio < 0.03:
        return "小冲", gap_ratio
    if gap_ratio < 0.15:
        return "稳", gap_ratio
    if gap_ratio < 0.35:
        return "保", gap_ratio
    return "垫", gap_ratio


def score(infile: Path, outfile: Path, student_rank: int) -> None:
    with infile.open("r", encoding="utf-8-sig", newline="") as src:
        reader = csv.DictReader(src)
        fields = list(reader.fieldnames or [])
        for extra in ("rank_gap", "gap_ratio", "risk_band"):
            if extra not in fields:
                fields.append(extra)
        rows = []
        for row in reader:
            try:
                min_rank = int(float((row.get("min_rank") or "").replace(",", "")))
            except ValueError:
                continue
            band, ratio = band_for(student_rank, min_rank)
            row["rank_gap"] = str(min_rank - student_rank)
            row["gap_ratio"] = f"{ratio:.4f}"
            row["risk_band"] = band
            rows.append(row)

    rows.sort(key=lambda r: (["冲", "小冲", "稳", "保", "垫"].index(r["risk_band"]), abs(float(r["gap_ratio"]))))
    with outfile.open("w", encoding="utf-8", newline="") as dst:
        writer = csv.DictWriter(dst, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_csv", type=Path)
    parser.add_argument("--rank", type=int, required=True, help="Student provincial rank.")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    score(args.input_csv, args.out, args.rank)


if __name__ == "__main__":
    main()
