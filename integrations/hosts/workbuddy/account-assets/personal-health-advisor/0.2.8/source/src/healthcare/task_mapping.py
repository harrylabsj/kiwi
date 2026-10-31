from __future__ import annotations

from typing import Any


TASKS_EXTENSION = "io.modelcontextprotocol/tasks"

_STATUS_MAP = {
    "awaiting_control": "input_required",
    "awaiting_identity": "input_required",
    "awaiting_review": "input_required",
    "partially_committed": "completed",
    "committed": "completed",
    "failed": "failed",
    "expired": "cancelled",
    "cancelled": "cancelled",
}


def task_status_for_application_status(status: str) -> str:
    """Map application state to the future Tasks projection state."""
    try:
        return _STATUS_MAP[status]
    except KeyError as exc:
        raise ValueError(f"unmapped application task status: {status}") from exc


def fallback_status_payload(request: dict[str, Any]) -> dict[str, Any]:
    """Return the legacy polling contract; never invent a Tasks handle."""
    status = str(request.get("status", ""))
    return {
        "request_id": request["request_id"],
        "job_id": request.get("job_id"),
        "application_status": status,
        "task_status_projection": task_status_for_application_status(status),
        "tasks_extension": TASKS_EXTENSION,
        "tasks_handle": None,
        "poll_via": "health_get_import_status",
    }
