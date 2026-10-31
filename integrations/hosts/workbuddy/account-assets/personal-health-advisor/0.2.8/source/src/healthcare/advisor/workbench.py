"""Self-contained, read-only HTML workbench (个人健康管理工作台).

The page inlines its CSS, JS and data, declares a CSP that blocks every
network request, and is written with 0600 permissions. Page interactions only
change what is displayed; every write goes through the Skill commands.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from importlib import resources
from pathlib import Path
from typing import Any

from .analytics import build_model
from .paths import data_dir

ALLOWED_DAYS = (14, 30, 90)


class WorkbenchError(ValueError):
    pass


def _json_for_script(value: Any) -> str:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        .replace("</", "<\\/")
        .replace(" ", "\\u2028")
        .replace(" ", "\\u2029")
    )


SNAPSHOT_CSP = (
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; '
    'script-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">'
)


def render_workbench(model: dict[str, Any] | None, *, ui_token: str | None = None) -> str:
    """Snapshot page when a model is given; embedded MCP Apps page when None.

    The snapshot inlines its data and a no-network CSP. The embedded page
    carries no data and no CSP meta (the MCP host applies the CSP declared on
    the resource) and fetches its model from `health_ui_model` at runtime.
    """
    template = resources.files(__package__).joinpath("workbench_template.html").read_text(encoding="utf-8")
    if model is None:
        if not ui_token:
            raise WorkbenchError("内嵌工作台需要本地界面能力令牌")
        title, data, csp, embedded = "个人健康管理工作台", _json_for_script({"ui_token": ui_token}), "", "true"
    else:
        title, data, csp, embedded = f"{model['person']['display_name']} · 个人健康管理工作台", _json_for_script(model), SNAPSHOT_CSP, "false"
    escaped_title = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return (
        template.replace("__TITLE__", escaped_title).replace("__CSP__", csp)
        .replace("__EMBEDDED__", embedded).replace("__DATA__", data)
    )


def _protected_paths() -> set[Path]:
    root = data_dir()
    return {root / name for name in ("family.vault", "demo.vault", "settings.json", "passphrase", "demo.json")}


def validate_output_path(output: Path) -> Path:
    output = output.expanduser()
    if output.suffix.lower() not in (".html", ".htm"):
        raise WorkbenchError("工作台输出文件必须以 .html 结尾")
    if output.is_symlink():
        raise WorkbenchError("输出路径不能是符号链接")
    if output.exists() and not output.is_file():
        raise WorkbenchError("输出路径已存在且不是普通文件")
    resolved = output.resolve()
    if resolved in {path.resolve() for path in _protected_paths()} or resolved.suffix == ".vault":
        raise WorkbenchError("不能覆盖档案、设置或口令文件")
    return output


def write_workbench(
    store: Any, person_id: str, output: Path, *, settings: dict[str, Any], mode: str, days: int,
    vault_label: str, today: date | None = None, generated_at: datetime | None = None,
) -> dict[str, Any]:
    if days not in ALLOWED_DAYS:
        raise WorkbenchError(f"--days 只能是 {', '.join(str(value) for value in ALLOWED_DAYS)}")
    output = validate_output_path(output)
    today = today or date.today()
    generated_at = generated_at or datetime.now()
    model = build_model(
        store, person_id, settings=settings, today=today, days=days, mode=mode,
        generated_at=generated_at, vault_label=vault_label,
    )
    html = render_workbench(model)
    from .paths import write_private_text

    write_private_text(output, html)
    return {
        "status": "generated",
        "output": str(output),
        "mode": mode,
        "person_id": person_id,
        "days": days,
        "sections": {
            "bp_readings": model["bp"]["stats"]["total"],
            "medication_rows": len(model["medications"]),
            "activities": len(model["activities"]),
            "sleep_records": model["sleep"]["stats"]["recorded"],
            "emotions": len(model["emotions"]),
            "labs": len(model["labs"]),
            "pending_candidates": model["pending"]["candidates"],
            "encounters": len(model["encounters"]),
        },
        "missing_today": model["today_block"]["missing"],
        "network_requests": "none",
    }
