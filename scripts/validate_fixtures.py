#!/usr/bin/env python3
"""Cross-language fixture validation for shopping.negotiation/0.1.

Validates every fixture under fixtures/negotiation/ against the frozen
JSON schemas in contracts/shopping.negotiation/0.1/ using Python's
jsonschema library. The TypeScript test suite performs the same checks
with Ajv; both must agree.

File naming convention: *.valid.json must validate; *.invalid-*.json
must be rejected.

Usage: python3 scripts/validate_fixtures.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import jsonschema
except ImportError:  # pragma: no cover
    print("ERROR: python3 package 'jsonschema' is required", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "contracts" / "shopping.negotiation" / "0.1"
FIXTURE_DIR = ROOT / "fixtures" / "negotiation"

# fixture filename prefix -> schema file
PREFIX_TO_SCHEMA = {
    "decision.": "decision.schema.json",
    "snapshot.": "snapshot.schema.json",
    "policy-result.": "policy-result.schema.json",
    "capabilities.": "capabilities.schema.json",
}


def main() -> int:
    failures: list[str] = []
    checked = 0

    schemas: dict[str, object] = {}
    for schema_file in SCHEMA_DIR.glob("*.schema.json"):
        schemas[schema_file.name] = json.loads(schema_file.read_text(encoding="utf-8"))

    for fixture in sorted(FIXTURE_DIR.glob("*.json")):
        schema_name = next(
            (s for prefix, s in PREFIX_TO_SCHEMA.items() if fixture.name.startswith(prefix)),
            None,
        )
        if schema_name is None:
            failures.append(f"{fixture.name}: no schema mapping for prefix")
            continue
        data = json.loads(fixture.read_text(encoding="utf-8"))
        expect_valid = ".valid." in fixture.name
        try:
            jsonschema.validate(instance=data, schema=schemas[schema_name])
            valid = True
            error = ""
        except jsonschema.ValidationError as exc:  # noqa: PERF203
            valid = False
            error = exc.message
        checked += 1
        if valid != expect_valid:
            if expect_valid:
                failures.append(f"{fixture.name}: expected VALID but rejected: {error}")
            else:
                failures.append(f"{fixture.name}: expected INVALID but accepted")

    for failure in failures:
        print(f"FAIL {failure}")
    print(f"{checked - len(failures)}/{checked} fixtures passed (python jsonschema)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
