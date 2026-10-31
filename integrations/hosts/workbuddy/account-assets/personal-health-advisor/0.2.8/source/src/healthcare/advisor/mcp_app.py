"""stdio MCP server with an MCP Apps workbench for 个人健康管理顾问.

Launched by WorkBuddy from the expert's bundled `.mcp.json`
(`scripts/health-advisor mcp`). It serves the same local Vault as the Skill
commands, plus a `ui://` resource that renders the health workbench inside
WorkBuddy. The page has no write-only MCP tools: it returns requested entries
to the conversation, where the normal user-confirmed record path applies.
No HTTP listener, no network.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from datetime import date, datetime
from typing import Any

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.lowlevel.helper_types import ReadResourceContents
from mcp.server.stdio import stdio_server

from ..vault import VaultError, VaultStore
from . import VERSION
from .analytics import build_model
from .auth import AuthError, open_vault, passphrase_source, resolve_passphrase
from .demo import DEMO_PERSON, ensure_demo_vault
from .paths import live_vault_path
from .settings import SettingsError, load_settings
from .workbench import ALLOWED_DAYS, render_workbench

SERVER_NAME = "personal-health-advisor"
WORKBENCH_URI = "ui://personal-health-advisor/workbench.html"
APP_MIME = "text/html;profile=mcp-app"
READ_ONLY = types.ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
WRITE = types.ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
MODE = {"type": "string", "enum": ["live", "demo"], "default": "live", "description": "live=个人档案；demo=独立虚构示例"}
DAYS = {"type": "integer", "enum": list(ALLOWED_DAYS), "default": 14}
UI_TOKEN_TTL_SECONDS = 5 * 60
_ui_capabilities: dict[str, float] = {}


class ToolError(ValueError):
    pass


def _ui_meta(**extra: Any) -> dict[str, Any]:
    """Both the nested (`ui.*`) and flat (`ui/*`) MCP Apps meta spellings."""
    meta: dict[str, Any] = {"ui": dict(extra)}
    if "resourceUri" in extra:
        meta["ui/resourceUri"] = extra["resourceUri"]
    return meta


def _issue_ui_token() -> str:
    now = time.monotonic()
    for token, expires_at in list(_ui_capabilities.items()):
        if expires_at <= now:
            del _ui_capabilities[token]
    token = secrets.token_urlsafe(32)
    _ui_capabilities[token] = now + UI_TOKEN_TTL_SECONDS
    return token


def _require_ui_token(token: Any) -> None:
    if not isinstance(token, str) or not token:
        raise ToolError("此工具只能由已打开的本地工作台调用")
    expires_at = _ui_capabilities.get(token)
    if expires_at is None or expires_at <= time.monotonic():
        _ui_capabilities.pop(token, None)
        raise ToolError("本地工作台会话已过期；请重新打开工作台")


class VaultAccess:
    """Open the Vault for one tool call; never caches the passphrase in a result."""

    def __init__(self, mode: str, person: str | None = None):
        if mode not in ("live", "demo"):
            raise ToolError("mode 只能是 live 或 demo")
        self.mode = mode
        self.settings = load_settings()
        if mode == "demo":
            self.vault_path = ensure_demo_vault(date.today())
            self.person_id = person or DEMO_PERSON
        else:
            self.vault_path = live_vault_path(self.settings.get("vault"))
            self.person_id = person or self.settings.get("person_id") or "me"

    def open(self) -> VaultStore:
        store = open_vault(self.vault_path, resolve_passphrase(self.mode))
        if self.person_id not in store.state["persons"]:
            if self.mode == "demo":
                raise ToolError(f"示例档案中没有人物 {self.person_id}")
            store.ensure_person(self.person_id, self.settings.get("display_name"))
            store.save()
        return store

    def model(self, store: VaultStore, days: int) -> dict[str, Any]:
        if days not in ALLOWED_DAYS:
            raise ToolError(f"days 只能是 {', '.join(str(value) for value in ALLOWED_DAYS)}")
        return build_model(
            store, self.person_id, settings=self.settings, today=date.today(), days=days, mode=self.mode,
            generated_at=datetime.now(), vault_label=self.vault_path.name,
        )


def _summary(model: dict[str, Any]) -> dict[str, Any]:
    """Model-visible overview: today's tiles and what is still missing, no raw records."""
    tiles = [{"label": tile["label"], "value": tile["value"], "unit": tile.get("unit"), "status": tile["status"]["text"]} for tile in model["today_block"]["tiles"]]
    return {
        "mode": model["mode"], "person": model["person"]["display_name"], "today": model["today"], "range": model["range"],
        "tiles": tiles, "missing_today": model["today_block"]["missing"],
        "bp": model["bp"]["stats"], "pending_candidates": model["pending"]["candidates"],
        "local_only": True,
        "note": "界面数据由本地档案生成；未记录不代表未发生。仅作记录整理参考，不构成诊断或治疗建议。",
    }


def _setup_state(access: VaultAccess) -> dict[str, Any] | None:
    """Return a useful first-run response without treating demo data as personal data."""
    if access.mode == "demo":
        return None
    vault_exists = access.vault_path.is_file()
    source = passphrase_source()
    if vault_exists and source != "none":
        return None
    return {
        "status": "setup_required", "mode": "live", "vault_exists": vault_exists,
        "passphrase_source": source, "demo_available": True, "local_only": True,
        "next_step": "可调用 health_open_workbench(mode=demo) 查看明确标记的虚构示例；个人档案请在本机用 Skill 的 auth init 或 auth import 配置，口令不要发到对话中。",
    }


def _auth_state(access: VaultAccess) -> dict[str, Any]:
    return {
        "status": "auth_failed", "mode": "live", "vault_exists": access.vault_path.is_file(),
        "passphrase_source": passphrase_source(), "demo_available": True, "local_only": True,
        "next_step": "本机档案无法解锁；请核对档案与口令文件，或先调用 health_open_workbench(mode=demo) 查看虚构示例。不要把口令发到对话中。",
    }


def _record(store: VaultStore, person: str, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    if kind == "vital":
        if payload.get("systolic") is None and payload.get("weight") is None:
            raise ToolError("至少提供血压（systolic 与 diastolic）或体重（weight）")
        if (payload.get("systolic") is None) != (payload.get("diastolic") is None):
            raise ToolError("收缩压与舒张压需要一起提供")
        added = store.record_vital(person, str(payload["at"]), payload.get("systolic"), payload.get("diastolic"), payload.get("heart_rate"), weight_kg=payload.get("weight"), note=payload.get("note"), source=payload.get("source"))
        result = {"type": "vital", "measured_at": payload["at"]}
    elif kind == "medication":
        added = store.record_medication(person, str(payload["at"]), str(payload["medication"]), payload.get("dose"), payload.get("unit"), taken=not payload.get("missed", False), note=payload.get("note"), medication_plan_id=payload.get("plan"))
        result = {"type": "medication", "medication": payload["medication"], "taken": not payload.get("missed", False)}
    elif kind == "activity":
        added = store.record_activity(person, str(payload["date"]), str(payload["activity_type"]), payload.get("duration"), payload.get("distance"), payload.get("steps"), note=payload.get("note"))
        result = {"type": "activity", "activity_type": payload["activity_type"], "date": payload["date"]}
    elif kind == "sleep":
        added = store.record_sleep(person, str(payload["date"]), duration_minutes=payload.get("duration"), bedtime=payload.get("bedtime"), wake_time=payload.get("wake_time"), quality=payload.get("quality"), note=payload.get("note"))
        result = {"type": "sleep", "date": payload["date"]}
    elif kind == "emotion":
        added = store.record_emotion(person, str(payload["at"]), str(payload["name"]), duration_minutes=payload.get("duration"), feelings=payload.get("feelings"), reflection=payload.get("reflection"))
        result = {"type": "emotion", "name": payload["name"], "occurred_at": payload["at"]}
    else:
        raise ToolError(f"不支持的记录类型：{kind}")
    store.save()
    result.update({"status": "recorded" if added else "duplicate", "person_id": person, "local_only": True})
    return result


def _obj(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": {"mode": MODE, **properties}, "required": required or [], "additionalProperties": False}


TOOLS: list[types.Tool] = [
    types.Tool(
        name="health_open_workbench", title="打开健康工作台",
        description="在 WorkBuddy 内打开个人健康管理工作台。全新用户可传 mode=demo 查看明确标记的虚构示例；未配置个人档案时返回建档引导。完整数据只进入界面。",
        inputSchema=_obj({"days": DAYS}), annotations=READ_ONLY, _meta=_ui_meta(resourceUri=WORKBENCH_URI),
    ),
    types.Tool(
        name="health_status", title="档案状态",
        description="无需口令即可查询是否已建档；已解锁时返回人物与近 7 天记录数量，不含口令。", inputSchema=_obj({}), annotations=READ_ONLY,
    ),
    types.Tool(
        name="health_recent", title="近期日常记录",
        description="近 N 天的血压、服药、运动、情绪、睡眠记录，用于回答问题和写后核验。",
        inputSchema=_obj({"days": {"type": "integer", "minimum": 1, "maximum": 366, "default": 7}}), annotations=READ_ONLY,
    ),
    types.Tool(
        name="health_trend", title="确定性趋势",
        description="返回数据点、覆盖天数、均值与警告；只复述，不推断因果或诊断。",
        inputSchema=_obj({"source": {"type": "string", "enum": ["vital", "observation"]}, "field": {"type": "string"}, "start": {"type": "string"}, "end": {"type": "string"}}, ["source", "field"]),
        annotations=READ_ONLY,
    ),
    types.Tool(
        name="health_labs", title="已确认检验",
        description="用户已逐字段确认的检验观察；待核对候选不在其中。",
        inputSchema=_obj({"field": {"type": "string"}}), annotations=READ_ONLY,
    ),
    types.Tool(
        name="health_record_vital", title="记录血压/体重",
        description="记录用户明确陈述的一次测量。at 为本地时间 YYYY-MM-DDTHH:MM。写后用 health_recent 核验。",
        inputSchema=_obj({"at": {"type": "string"}, "systolic": {"type": "integer"}, "diastolic": {"type": "integer"}, "heart_rate": {"type": "integer"}, "weight": {"type": "number"}, "note": {"type": "string"}, "source": {"type": "string", "description": "时段标签（晨间/晚间），存入记录 source 字段"}}, ["at"]),
        annotations=WRITE,
    ),
    types.Tool(
        name="health_record_medication", title="记录实际服药",
        description="记录用户明确说已服（或明确未服，missed=true）的一次用药事件；不是提醒，不是计划。",
        inputSchema=_obj({"at": {"type": "string"}, "medication": {"type": "string"}, "dose": {"type": "string"}, "unit": {"type": "string"}, "missed": {"type": "boolean", "default": False}, "plan": {"type": "string"}, "note": {"type": "string"}}, ["at", "medication"]),
        annotations=WRITE,
    ),
    types.Tool(
        name="health_record_activity", title="记录运动/冥想",
        description="记录一次运动或冥想；计数型运动把个数写进 note，如“共 60 个”。",
        inputSchema=_obj({"date": {"type": "string"}, "activity_type": {"type": "string"}, "duration": {"type": "number"}, "distance": {"type": "number"}, "steps": {"type": "integer"}, "note": {"type": "string"}}, ["date", "activity_type"]),
        annotations=WRITE,
    ),
    types.Tool(
        name="health_record_sleep", title="记录睡眠",
        description="date 为起床日；给 duration（分钟）或 bedtime + wake_time。",
        inputSchema=_obj({"date": {"type": "string"}, "duration": {"type": "number"}, "bedtime": {"type": "string"}, "wake_time": {"type": "string"}, "quality": {"type": "integer", "minimum": 1, "maximum": 5}, "note": {"type": "string"}}, ["date"]),
        annotations=WRITE,
    ),
    types.Tool(
        name="health_record_emotion", title="记录情绪",
        description="记录情绪名称、时长、感受与感悟；只写用户自己的话，不把建议写成感悟。",
        inputSchema=_obj({"at": {"type": "string"}, "name": {"type": "string"}, "duration": {"type": "number"}, "feelings": {"type": "string"}, "reflection": {"type": "string"}}, ["at", "name"]),
        annotations=WRITE,
    ),
    types.Tool(
        name="health_candidates", title="待核对字段",
        description="列出一份导入报告的候选字段（原值、单位、是否需要换算）。候选在用户逐字段确认前不是健康事实。",
        inputSchema=_obj({"job_id": {"type": "string"}}, ["job_id"]), annotations=READ_ONLY,
    ),
    types.Tool(
        name="health_visit_summary", title="就医摘要草稿",
        description="带来源的就医资料草稿；用户核对后再携带。不含诊断或治疗建议。",
        inputSchema=_obj({"start": {"type": "string"}, "end": {"type": "string"}}), annotations=READ_ONLY,
    ),
    types.Tool(
        name="health_ui_model", description="仅供内嵌工作台获取界面数据；完整记录只放入 UI 元数据，不进入模型可见文本。",
        inputSchema=_obj({"days": DAYS, "ui_token": {"type": "string", "description": "由内嵌工作台资源提供的短时能力令牌"}}, ["ui_token"]), annotations=READ_ONLY, _meta=_ui_meta(visibility=["app"]),
    ),
]


def _text_result(data: Any) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(data, ensure_ascii=False))], structuredContent=data if isinstance(data, dict) else {"items": data})


def _ui_result(model: dict[str, Any], text: str = "本地界面数据已更新。") -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)], _meta={"healthData": model})


def _error(message: str) -> types.CallToolResult:
    return types.CallToolResult(isError=True, content=[types.TextContent(type="text", text=message)])


def handle_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
    args = dict(arguments or {})
    mode = args.pop("mode", "live")
    try:
        access = VaultAccess(mode)
        if name == "health_open_workbench":
            setup = _setup_state(access)
            if setup:
                return _text_result(setup)
            try:
                store = access.open()
            except AuthError:
                return _text_result(_auth_state(access))
            return _text_result(_summary(access.model(store, int(args.get("days", 14)))))
        if name == "health_ui_model":
            _require_ui_token(args.get("ui_token"))
            setup = _setup_state(access)
            if setup:
                return _text_result(setup)
            try:
                store = access.open()
            except AuthError:
                return _text_result(_auth_state(access))
            return _ui_result(access.model(store, int(args.get("days", 14))))
        if name == "health_status":
            setup = _setup_state(access)
            if setup:
                return _text_result(setup)
            try:
                store = open_vault(access.vault_path, resolve_passphrase(mode))
            except AuthError:
                return _text_result(_auth_state(access))
            if access.person_id not in store.state["persons"]:
                return _text_result({"status": "person_not_found", "mode": mode, "person_id": access.person_id, "vault_exists": True, "demo_available": True, "local_only": True})
            recent = store.recent(access.person_id, 7)
            return _text_result({"status": "ready", "mode": mode, "person_id": access.person_id, "vault": access.vault_path.name, "recent_7_days": {key: len(value) for key, value in recent.items() if isinstance(value, list)}, "local_only": True})
        if name == "health_recent":
            days = int(args.get("days", 7))
            store = access.open()
            payload = store.recent(access.person_id, days)
            payload.update({"person_id": access.person_id, "mode": mode})
            return _text_result(payload)
        if name == "health_trend":
            store = access.open()
            return _text_result(store.trend_summary(access.person_id, args["source"], args["field"], args.get("start"), args.get("end")))
        if name == "health_labs":
            store = access.open()
            return _text_result({"person_id": access.person_id, "observations": store.observations(access.person_id, args.get("field"))})
        if name.startswith("health_record_"):
            store = access.open()
            return _text_result(_record(store, access.person_id, name.removeprefix("health_record_"), args))
        if name == "health_candidates":
            store = access.open()
            job = store.state["jobs"].get(args["job_id"])
            if not job or job.get("person_id") not in (access.person_id, None):
                raise ToolError("没有这份导入任务")
            candidates = [store.state["candidates"][cid] for cid in job["candidate_ids"] if cid in store.state["candidates"]]
            return _text_result({"job_id": job["id"], "status": job["status"], "candidates": [
                {"field": item["field"], "raw_value": item["raw_value"], "value": item.get("text_value") if item.get("value_type") == "text" else item.get("normalized_value"), "unit": item.get("unit"), "raw_unit": item.get("raw_unit"), "mapping_status": item.get("mapping_status"), "status": item.get("status"), "needs_unit_conversion": item.get("mapping_status") != "mapped"}
                for item in candidates
            ]})
        if name == "health_visit_summary":
            store = access.open()
            return _text_result(store.visit_summary(access.person_id, args.get("start"), args.get("end")))
        return _error(f"未知工具：{name}")
    except AuthError as exc:
        return _error(f"未授权：{exc}")
    except (ToolError, SettingsError, VaultError, KeyError, ValueError) as exc:
        return _error(str(exc) if not isinstance(exc, KeyError) else f"缺少参数：{exc}")


def workbench_page() -> str:
    """Embedded page: same template, data comes from health_ui_model at runtime."""
    return render_workbench(None, ui_token=_issue_ui_token())


def build_server() -> Server:
    server = Server(SERVER_NAME, version=VERSION, instructions="本地个人健康档案。读取优先；写入只记录用户明确陈述的事件；候选逐字段确认；不诊断、不处方。")

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return TOOLS

    @server.call_tool(validate_input=True)
    async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        return await asyncio.to_thread(handle_tool, name, arguments)

    @server.list_resources()
    async def list_resources() -> list[types.Resource]:
        return [types.Resource(uri=WORKBENCH_URI, name="health-workbench", title="个人健康管理工作台", description="个人健康管理顾问的内嵌工作台", mimeType=APP_MIME, _meta={"ui": {"csp": {"connectDomains": [], "resourceDomains": []}}})]

    @server.read_resource()
    async def read_resource(uri: Any) -> list[ReadResourceContents]:
        if str(uri) != WORKBENCH_URI:
            raise ValueError(f"unknown resource: {uri}")
        return [ReadResourceContents(content=workbench_page(), mime_type=APP_MIME, meta={"ui": {"csp": {"connectDomains": [], "resourceDomains": []}}})]

    return server


async def serve() -> None:
    server = build_server()
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


def main() -> int:
    asyncio.run(serve())
    return 0
