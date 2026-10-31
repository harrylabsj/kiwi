from __future__ import annotations

import json
from importlib.resources import files
from typing import Any

from jsonschema import Draft202012Validator

from .models import serialize

SCHEMA_DIR = files("healthcare").joinpath("schema_data")

_SCHEMA_NAMES = (
    "observation",
    "field-candidate",
    "evidence-record",
    "import-job",
    "mcp-envelope",
)

_loaded: dict[str, dict[str, Any]] = {}
_validators: dict[str, Draft202012Validator] = {}


class SchemaError(ValueError):
    """An entity or envelope violated the frozen Phase 1A0 schema contract."""


def schema_names() -> tuple[str, ...]:
    return _SCHEMA_NAMES


def load(name: str) -> dict[str, Any]:
    """Load a frozen schema document by name (cached)."""
    if name not in _SCHEMA_NAMES:
        raise SchemaError(f"unknown schema: {name}")
    if name not in _loaded:
        path = SCHEMA_DIR.joinpath(f"{name}.schema.json")
        try:
            _loaded[name] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SchemaError(f"unable to load schema {name}: {exc}") from exc
    return _loaded[name]


def _validator(name: str) -> Draft202012Validator:
    if name not in _validators:
        _validators[name] = Draft202012Validator(
            load(name),
            format_checker=Draft202012Validator.FORMAT_CHECKER,
        )
    return _validators[name]


def validate(instance: Any, name: str) -> None:
    """Validate an instance against the named frozen schema.

    Raises :class:`SchemaError` on the first violation; the message includes the
    JSON pointer to the offending path so fixes are localizable.
    """
    validator = _validator(name)
    error = next(validator.iter_errors(instance), None)
    if error is not None:
        path = "/".join(str(part) for part in error.absolute_path) or "/"
        raise SchemaError(f"{name} schema violation at {path}: {error.message}")


def validate_entity(entity: Any, name: str) -> None:
    """Validate a models dataclass or an already-serialized dict."""
    instance = entity if isinstance(entity, dict) else serialize(entity)
    validate(instance, name)


def validate_vault_entities(state: dict[str, Any]) -> None:
    """Validate every persisted entity of the 1A0 normative set in Vault state."""
    for entity in state.get("observations", {}).values():
        validate(entity, "observation")
    for entity in state.get("candidates", {}).values():
        validate(entity, "field-candidate")
    for entity in state.get("evidence", {}).values():
        validate(entity, "evidence-record")
    for entity in state.get("jobs", {}).values():
        validate(entity, "import-job")
