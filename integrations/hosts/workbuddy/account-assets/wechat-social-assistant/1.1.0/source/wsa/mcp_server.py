from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
import sys
from typing import Any
from urllib.parse import parse_qs, urlparse

from .audit import audit_report_to_dict, build_audit_report, render_audit_report_markdown
from .cli import (
    _best_hidden_suggestion,
    _brief_display_evidence,
    _brief_no_suggestion_message,
    _filter_profiles,
    _filter_suggestions,
    _obsidian_filename_map,
    _render_brief_markdown,
    _render_contacts_markdown,
    _render_obsidian_daily_report,
    _render_obsidian_weekly_report,
    _obsidian_week_label,
)
from .candidates import (
    candidate_to_dict,
    confirm_relationship_candidate,
    discover_relationship_candidates,
    render_candidates_markdown,
)
from .dashboard import (
    build_relationship_dashboard,
    dashboard_to_dict,
    render_relationship_dashboard_markdown,
)
from .enrichment import enrichment_by_person, enrichment_to_dict
from .feedback import (
    FEEDBACK_ACTIONS,
    feedback_to_dict,
    list_feedback,
    record_feedback,
    render_feedback_markdown,
)
from .profiles import ContactProfile, build_profiles
from .relationship_quality import (
    build_relationship_quality_cards,
    quality_card_to_dict,
    render_relationship_quality_markdown,
)
from .reviews import (
    REVIEW_ACTIONS,
    REVIEW_CONFIRMATION_TEXT,
    REVIEW_STATUSES,
    list_ocr_reviews,
    record_ocr_review,
    render_ocr_reviews,
    review_to_dict,
)
from .security import (
    configure_mcp_path_policy,
    resolve_mcp_path,
)
from .sources import (
    SOURCE_TYPES,
    list_relationship_sources,
    render_relationship_sources_markdown,
    source_to_dict,
)
from .status import StatusReport, build_status_report, render_status_report
from .store import connect, default_db_path, list_ocr_observations
from .suggestions import Suggestion, build_suggestions, followup_strength_label


MCP_PROTOCOL_VERSION = "2025-11-25"
SERVER_VERSION = "1.1.0"
SERVER_SCHEMA_VERSION = "1.1.0"
MCP_CAPABILITIES = (
    "read_relationship_memory",
    "structured_ocr_observations",
    "ocr_review_queue",
    "confirmed_local_writes",
    "path_policy",
)

MCP_TOOLS = [
    {
        "name": "get_status",
        "description": "Read local WSA database, capture, log, and watch-process status without changing local data.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "db_path": {"type": "string", "description": "Optional path to social.db."},
                "captures_dir": {"type": "string", "description": "Optional screenshot directory."},
                "log_file": {"type": "string", "description": "Optional watch log path."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_audit_report",
        "description": "Read a local data audit report with table counts and storage paths.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "search_contacts",
        "description": "Search contact-centered profiles by name, source chat, organization, links, files, or recent content.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Contact, source chat, or clue to search for."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_contact_brief",
        "description": "Read one contact brief with recent content, source chats, evidence, and next follow-up draft.",
        "inputSchema": {
            "type": "object",
            "required": ["contact_name"],
            "properties": {
                "contact_name": {"type": "string", "description": "Contact or source chat to brief."},
                "min_score": {"type": "integer", "minimum": 0, "default": 0},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_next_followup",
        "description": "Read the highest-priority next follow-up suggestion and draft, optionally filtered by contact.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "contact_name": {"type": "string", "description": "Optional contact or source chat filter."},
                "min_score": {"type": "integer", "minimum": 0, "default": 45},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_daily_report",
        "description": "Render today's local relationship analysis report in memory without writing files.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "Report date as YYYY-MM-DD. Defaults to today."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
                "min_score": {"type": "integer", "minimum": 0, "default": 45},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_weekly_report",
        "description": "Render the local weekly relationship report in memory without writing files.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "Any date inside the ISO week. Defaults to today."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
                "min_score": {"type": "integer", "minimum": 0, "default": 45},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_relationship_quality",
        "description": "Read the relationship quality operating desk with evidence-backed scores, risks, gaps, and next actions.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "contact_name": {"type": "string", "description": "Optional contact or source chat filter."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
                "min_score": {"type": "integer", "minimum": 0, "default": 45},
                "as_of": {"type": "string", "description": "Optional ISO timestamp for recency scoring."},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_relationship_dashboard",
        "description": "Read the daily relationship dashboard: priorities, cooling contacts, candidates, commitments, and group signals.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "Optional analysis date or ISO timestamp."},
                "as_of": {"type": "string", "description": "Optional ISO timestamp for recency scoring."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 8},
                "min_score": {"type": "integer", "minimum": 0, "default": 45},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "list_relationship_sources",
        "description": "Read locally imported relationship sources from contacts, calendars, notes, Obsidian, or email files.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "contact_name": {"type": "string", "description": "Optional contact filter."},
                "source_type": {
                    "type": "string",
                    "enum": list(SOURCE_TYPES),
                    "description": "Optional source type filter.",
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "list_relationship_candidates",
        "description": "Read candidate relationships discovered from group chats and event-like contexts.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["pending", "confirmed", "dismissed"],
                    "description": "Optional lifecycle status filter.",
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
                "min_confidence": {"type": "integer", "minimum": 0, "default": 45},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "confirm_relationship_candidate",
        "description": "Confirm a relationship candidate as a local contact after explicit user confirmation.",
        "inputSchema": {
            "type": "object",
            "required": ["confirmed", "confirmation_text"],
            "properties": {
                "id": {"type": "integer", "description": "Candidate id."},
                "name": {"type": "string", "description": "Candidate name."},
                "source_chat": {"type": "string", "description": "Source group/event chat."},
                "note": {"type": "string", "description": "Optional user note."},
                "confirmed_at": {"type": "string", "description": "Optional audit timestamp override."},
                "confirmed": {"type": "boolean", "description": "Must be true after explicit user confirmation."},
                "confirmation_text": {
                    "type": "string",
                    "description": "Must exactly equal: confirm relationship candidate",
                },
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False},
    },
    {
        "name": "list_feedback",
        "description": "Read local feedback records for follow-up suggestions.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "contact_name": {"type": "string", "description": "Optional contact filter."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "record_feedback",
        "description": "Write a local feedback record after explicit user confirmation.",
        "inputSchema": {
            "type": "object",
            "required": ["contact_name", "action", "confirmed", "confirmation_text"],
            "properties": {
                "contact_name": {"type": "string", "description": "Contact name."},
                "action": {"type": "string", "enum": list(FEEDBACK_ACTIONS)},
                "note": {"type": "string", "description": "Optional user note."},
                "until_at": {"type": "string", "description": "Required for snooze; ISO timestamp."},
                "created_at": {"type": "string", "description": "Optional audit timestamp override."},
                "confirmed": {"type": "boolean", "description": "Must be true after explicit user confirmation."},
                "confirmation_text": {
                    "type": "string",
                    "description": "Must exactly equal: record local feedback",
                },
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False},
    },
    {
        "name": "list_recent_captures",
        "description": "List recent captured conversation records and metadata without reading image bytes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_capture_observations",
        "description": "Read structured OCR observations, normalized bounding boxes, confidence, and speaker candidates for one capture.",
        "inputSchema": {
            "type": "object",
            "required": ["capture_id"],
            "properties": {
                "capture_id": {"type": "integer", "minimum": 1, "description": "Capture id."},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "list_ocr_reviews",
        "description": "Read the human review queue for low-confidence OCR observations.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["pending", *REVIEW_STATUSES],
                    "default": "pending",
                },
                "max_confidence": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1,
                    "default": 0.75,
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "record_ocr_review",
        "description": "Write an OCR accept/reject/correction after explicit user confirmation.",
        "inputSchema": {
            "type": "object",
            "required": ["observation_id", "action", "confirmed", "confirmation_text"],
            "properties": {
                "observation_id": {"type": "integer", "minimum": 1},
                "action": {"type": "string", "enum": list(REVIEW_ACTIONS)},
                "corrected_text": {"type": "string"},
                "corrected_speaker": {"type": "string"},
                "note": {"type": "string"},
                "confirmed": {"type": "boolean", "description": "Must be true after user confirmation."},
                "confirmation_text": {
                    "type": "string",
                    "description": f"Must exactly equal: {REVIEW_CONFIRMATION_TEXT}",
                },
                "reviewed_at": {"type": "string", "description": "Optional ISO audit timestamp."},
                "db_path": {"type": "string", "description": "Optional path to social.db."},
            },
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False},
    },
]

MCP_RESOURCES = [
    {
        "uri": "wsa://status",
        "name": "WSA status",
        "description": "Current local database, capture, log, and watch status.",
        "mimeType": "text/markdown",
    },
    {
        "uri": "wsa://audit",
        "name": "WSA audit",
        "description": "Local data audit with table counts and storage paths.",
        "mimeType": "text/markdown",
    },
    {
        "uri": "wsa://contacts",
        "name": "WSA contacts",
        "description": "Contact-centered relationship profiles from existing local captures.",
        "mimeType": "text/markdown",
    },
    {
        "uri": "wsa://daily-report",
        "name": "WSA daily report",
        "description": "Daily relationship analysis and proactive follow-up drafts rendered in memory.",
        "mimeType": "text/markdown",
    },
    {
        "uri": "wsa://weekly-report",
        "name": "WSA weekly report",
        "description": "Weekly relationship report with follow-ups, manual enrichment, gaps, and recent changes.",
        "mimeType": "text/markdown",
    },
    {
        "uri": "wsa://relationship-quality",
        "name": "WSA relationship quality",
        "description": "Evidence-backed relationship quality scores, risks, information gaps, and next actions.",
        "mimeType": "text/markdown",
    },
    {
        "uri": "wsa://relationship-dashboard",
        "name": "WSA relationship dashboard",
        "description": "Daily relationship operating dashboard for priorities, cooling contacts, candidates, commitments, and groups.",
        "mimeType": "text/markdown",
    },
    {
        "uri": "wsa://relationship-sources",
        "name": "WSA relationship sources",
        "description": "Locally imported relationship sources from contacts, calendars, notes, Obsidian, and email files.",
        "mimeType": "text/markdown",
    },
    {
        "uri": "wsa://relationship-candidates",
        "name": "WSA relationship candidates",
        "description": "Candidate relationships discovered from group chats and event-like contexts.",
        "mimeType": "text/markdown",
    },
]

MCP_PROMPTS = [
    {
        "name": "daily-relationship-review",
        "description": "Guide an agent to review today's local relationship report safely.",
        "arguments": [
            {"name": "date", "description": "Optional report date as YYYY-MM-DD.", "required": False}
        ],
    },
    {
        "name": "weekly-relationship-review",
        "description": "Guide an agent to review the weekly local relationship report safely.",
        "arguments": [
            {"name": "date", "description": "Optional date inside the ISO week.", "required": False}
        ],
    },
    {
        "name": "contact-followup",
        "description": "Guide an agent to prepare a user-reviewed follow-up for one contact.",
        "arguments": [
            {"name": "contact_name", "description": "Contact or source chat name.", "required": True}
        ],
    },
    {
        "name": "safe-capture-review",
        "description": "Guide an agent through privacy-preserving capture review and import planning.",
        "arguments": [],
    },
    {
        "name": "relationship-candidate-review",
        "description": "Guide an agent to review group/event relationship candidates without contacting anyone automatically.",
        "arguments": [
            {"name": "min_confidence", "description": "Optional minimum confidence threshold.", "required": False}
        ],
    },
]


def handle_jsonrpc(message: dict[str, Any]) -> dict[str, Any] | None:
    request_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}
    if request_id is None and method and method.startswith("notifications/"):
        return None
    if not isinstance(method, str):
        return _error(request_id, -32600, "Invalid Request")

    try:
        if method == "initialize":
            return _result(request_id, _initialize_result())
        if method == "ping":
            return _result(request_id, {})
        if method == "tools/list":
            return _result(request_id, {"tools": MCP_TOOLS})
        if method == "tools/call":
            return _result(request_id, _handle_tool_call(params))
        if method == "resources/list":
            return _result(request_id, {"resources": MCP_RESOURCES})
        if method == "resources/read":
            return _result(request_id, _handle_resource_read(params))
        if method == "prompts/list":
            return _result(request_id, {"prompts": MCP_PROMPTS})
        if method == "prompts/get":
            return _result(request_id, _handle_prompt_get(params))
    except ValueError as exc:
        return _error(request_id, -32602, str(exc))
    except Exception as exc:  # pragma: no cover - defensive JSON-RPC boundary
        return _error(request_id, -32603, f"Internal error: {exc}")

    return _error(request_id, -32601, "Method not found")


def serve_stdio(infile=sys.stdin, outfile=sys.stdout) -> None:
    for line in infile:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            response = _error(None, -32700, f"Parse error: {exc.msg}")
        else:
            response = handle_jsonrpc(message)
        if response is not None:
            outfile.write(json.dumps(response, ensure_ascii=False) + "\n")
            outfile.flush()


def main(argv: list[str] | None = None) -> int:
    configure_mcp_path_policy()
    parser = argparse.ArgumentParser(description="Run WeChat Social Assistant as a local-first MCP server.")
    parser.add_argument(
        "--transport",
        choices=["stdio"],
        default="stdio",
        help="MCP transport to use. Only stdio is supported.",
    )
    parser.add_argument("--version", action="version", version=f"wechat-social-assistant-mcp {SERVER_VERSION}")
    parser.parse_args(argv)
    serve_stdio()
    return 0


def _initialize_result() -> dict[str, Any]:
    return {
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {
            "tools": {},
            "resources": {},
            "prompts": {},
        },
        "serverInfo": {
            "name": "wechat-social-assistant",
            "version": SERVER_VERSION,
            "schemaVersion": SERVER_SCHEMA_VERSION,
            "capabilities": list(MCP_CAPABILITIES),
        },
    }


def _handle_tool_call(params: dict[str, Any]) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    if not isinstance(name, str):
        raise ValueError("tools/call requires a tool name")
    if not isinstance(arguments, dict):
        raise ValueError("tools/call arguments must be an object")
    handlers = {
        "get_status": _tool_get_status,
        "get_audit_report": _tool_get_audit_report,
        "search_contacts": _tool_search_contacts,
        "get_contact_brief": _tool_get_contact_brief,
        "get_next_followup": _tool_get_next_followup,
        "get_daily_report": _tool_get_daily_report,
        "get_weekly_report": _tool_get_weekly_report,
        "get_relationship_quality": _tool_get_relationship_quality,
        "get_relationship_dashboard": _tool_get_relationship_dashboard,
        "list_relationship_sources": _tool_list_relationship_sources,
        "list_relationship_candidates": _tool_list_relationship_candidates,
        "confirm_relationship_candidate": _tool_confirm_relationship_candidate,
        "list_feedback": _tool_list_feedback,
        "record_feedback": _tool_record_feedback,
        "list_recent_captures": _tool_list_recent_captures,
        "get_capture_observations": _tool_get_capture_observations,
        "list_ocr_reviews": _tool_list_ocr_reviews,
        "record_ocr_review": _tool_record_ocr_review,
    }
    handler = handlers.get(name)
    if handler is None:
        raise ValueError(f"unknown tool: {name}")
    return handler(arguments)


def _handle_resource_read(params: dict[str, Any]) -> dict[str, Any]:
    uri = params.get("uri")
    arguments = params.get("arguments") or {}
    if not isinstance(uri, str):
        raise ValueError("resources/read requires a uri")
    if not isinstance(arguments, dict):
        raise ValueError("resources/read arguments must be an object")
    parsed = urlparse(uri)
    if parsed.scheme != "wsa":
        raise ValueError(f"unsupported resource uri: {uri}")
    query_arguments = _query_arguments(parsed.query)
    merged_arguments = {**query_arguments, **arguments}
    normalized_uri = f"wsa://{parsed.netloc}{parsed.path}"

    if normalized_uri == "wsa://status":
        tool_result = _tool_get_status(merged_arguments)
    elif normalized_uri == "wsa://audit":
        tool_result = _tool_get_audit_report(merged_arguments)
    elif normalized_uri == "wsa://contacts":
        tool_result = _tool_search_contacts(merged_arguments)
    elif normalized_uri == "wsa://daily-report":
        tool_result = _tool_get_daily_report(merged_arguments)
    elif normalized_uri == "wsa://weekly-report":
        tool_result = _tool_get_weekly_report(merged_arguments)
    elif normalized_uri == "wsa://relationship-quality":
        tool_result = _tool_get_relationship_quality(merged_arguments)
    elif normalized_uri == "wsa://relationship-dashboard":
        tool_result = _tool_get_relationship_dashboard(merged_arguments)
    elif normalized_uri == "wsa://relationship-sources":
        tool_result = _tool_list_relationship_sources(merged_arguments)
    elif normalized_uri == "wsa://relationship-candidates":
        tool_result = _tool_list_relationship_candidates(merged_arguments)
    else:
        raise ValueError(f"unknown resource uri: {uri}")
    return {
        "contents": [
            {
                "uri": normalized_uri,
                "mimeType": "text/markdown",
                "text": tool_result["content"][0]["text"],
            }
        ]
    }


def _handle_prompt_get(params: dict[str, Any]) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    if not isinstance(name, str):
        raise ValueError("prompts/get requires a prompt name")
    if not isinstance(arguments, dict):
        raise ValueError("prompts/get arguments must be an object")
    if name == "daily-relationship-review":
        report_date = str(arguments.get("date") or date.today().isoformat())
        text = (
            f"请以只读方式调用 wechat-social-assistant 的 get_daily_report，日期为 {report_date}。"
            "总结人脉变化、应该主动联系的人、每条草稿的语气风险，并提醒用户所有发送动作都需要人工确认。"
        )
    elif name == "weekly-relationship-review":
        report_date = str(arguments.get("date") or date.today().isoformat())
        text = (
            f"请以只读方式调用 wechat-social-assistant 的 get_weekly_report，日期为 {report_date}。"
            "总结本周应联系的人、手工补充的人脉、资料缺口和关系风险；不要代用户发送微信。"
        )
    elif name == "contact-followup":
        contact_name = str(arguments.get("contact_name") or "").strip()
        if not contact_name:
            raise ValueError("contact-followup requires contact_name")
        text = (
            f"请以只读方式查询联系人「{contact_name}」的 get_contact_brief 和 get_next_followup。"
            "基于已有证据给出一版可编辑微信草稿，标明信息来源和不确定性，不要代用户发送。"
        )
    elif name == "safe-capture-review":
        text = (
            "请只读取 wechat-social-assistant 的状态和最近采集记录，检查是否存在隐私风险、误采集、"
            "低质量 OCR 或需要用户确认的导入事项。不要启动截图、不要读取微信私有数据库、不要写入文件。"
        )
    elif name == "relationship-candidate-review":
        min_confidence = str(arguments.get("min_confidence") or 45)
        text = (
            f"请以只读方式调用 list_relationship_candidates，min_confidence={min_confidence}。"
            "按来源群/活动、证据、置信度和破冰风险整理值得认识的人；不要主动发送微信，"
            "需要转为正式联系人时必须先向用户确认，再调用 confirm_relationship_candidate。"
        )
    else:
        raise ValueError(f"unknown prompt: {name}")
    return {
        "description": _prompt_description(name),
        "messages": [
            {
                "role": "user",
                "content": {"type": "text", "text": text},
            }
        ],
    }


def _tool_get_status(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    report = build_status_report(
        db_path,
        log_file=_optional_path(arguments.get("log_file"), base=db_path.parent),
        captures_dir=_optional_path(arguments.get("captures_dir"), base=db_path.parent),
    )
    return _tool_result(render_status_report(report), _status_to_dict(report))


def _tool_get_audit_report(arguments: dict[str, Any]) -> dict[str, Any]:
    report = build_audit_report(_db_path(arguments))
    return _tool_result(
        render_audit_report_markdown(report),
        {"audit": audit_report_to_dict(report)},
    )


def _tool_search_contacts(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    query = _optional_str(arguments.get("query"))
    limit = _limit(arguments.get("limit"), default=20)
    profiles = _profiles_or_empty(db_path)
    profiles = _filter_profiles(profiles, query)[:limit]
    markdown = _render_contacts_markdown(profiles, query=query)
    return _tool_result(
        markdown,
        {
            "query": query,
            "count": len(profiles),
            "contacts": [_profile_to_dict(profile) for profile in profiles],
        },
    )


def _tool_get_contact_brief(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    contact_name = str(arguments.get("contact_name") or "").strip()
    if not contact_name:
        raise ValueError("get_contact_brief requires contact_name")
    min_score = _min_score(arguments.get("min_score"), default=0)
    profiles = _filter_profiles(_profiles_or_empty(db_path), contact_name)
    suggestions = _suggestions_or_empty(db_path, limit=1000, min_score=min_score)
    suggestions = _filter_suggestions(suggestions, contact_name, matched_profiles=profiles)
    hidden_suggestion = (
        _best_hidden_suggestion(db_path, contact_name, min_score=min_score, matched_profiles=profiles)
        if db_path.exists() and not suggestions
        else None
    )
    evidence = _brief_display_evidence(db_path, profiles, suggestions[:1]) if db_path.exists() else None
    markdown = _render_brief_markdown(
        profiles,
        suggestions[:1],
        query=contact_name,
        evidence=evidence,
        no_suggestion_message=_brief_no_suggestion_message(
            contact_name,
            min_score=min_score,
            hidden_suggestion=hidden_suggestion,
        ),
    )
    return _tool_result(
        markdown,
        {
            "contact_name": contact_name,
            "profile": _profile_to_dict(profiles[0]) if profiles else None,
            "matches": [_profile_to_dict(profile) for profile in profiles[:8]],
            "suggestion": _suggestion_to_dict(suggestions[0]) if suggestions else None,
        },
    )


def _tool_get_next_followup(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    contact_name = _optional_str(arguments.get("contact_name"))
    min_score = _min_score(arguments.get("min_score"), default=45)
    matched_profiles = _filter_profiles(_profiles_or_empty(db_path), contact_name) if contact_name else []
    suggestions = _suggestions_or_empty(db_path, limit=1000 if contact_name else 1, min_score=min_score)
    suggestions = _filter_suggestions(suggestions, contact_name, matched_profiles=matched_profiles)
    top = suggestions[0] if suggestions else None
    if top:
        text = _render_followup_text(top)
    else:
        target = f"「{contact_name}」" if contact_name else "当前数据库"
        text = f"# 下一步跟进\n\n{target}暂无达到阈值 {min_score} 的跟进建议。\n"
    return _tool_result(
        text,
        {
            "contact_name": contact_name,
            "min_score": min_score,
            "suggestion": _suggestion_to_dict(top) if top else None,
        },
    )


def _tool_get_daily_report(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    report_date = str(arguments.get("date") or date.today().isoformat())
    limit = _limit(arguments.get("limit"), default=20)
    min_score = _min_score(arguments.get("min_score"), default=45)
    profiles = _profiles_or_empty(db_path)
    followups = _suggestions_or_empty(db_path, limit=limit, min_score=min_score)
    status_report = build_status_report(db_path)
    filename_by_name = _obsidian_filename_map(profile.name for profile in profiles)
    markdown = _render_obsidian_daily_report(
        report_date,
        profiles,
        followups,
        status_report=status_report,
        min_score=min_score,
        filename_by_name=filename_by_name,
    )
    return _tool_result(
        markdown,
        {
            "date": report_date,
            "profile_count": len(profiles),
            "followups": [_suggestion_to_dict(suggestion) for suggestion in followups],
            "status": _status_to_dict(status_report),
        },
    )


def _tool_get_weekly_report(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    report_date = str(arguments.get("date") or date.today().isoformat())
    limit = _limit(arguments.get("limit"), default=20)
    min_score = _min_score(arguments.get("min_score"), default=45)
    profiles = _profiles_or_empty(db_path)
    followups = _suggestions_or_empty(db_path, limit=limit, min_score=min_score)
    status_report = build_status_report(db_path)
    enrichments = enrichment_by_person(db_path) if db_path.exists() else {}
    filename_by_name = _obsidian_filename_map(profile.name for profile in profiles)
    markdown = _render_obsidian_weekly_report(
        report_date,
        profiles,
        followups,
        status_report=status_report,
        min_score=min_score,
        filename_by_name=filename_by_name,
        enrichments_by_person=enrichments,
    )
    return _tool_result(
        markdown,
        {
            "date": report_date,
            "week": _obsidian_week_label(report_date),
            "profile_count": len(profiles),
            "followups": [_suggestion_to_dict(suggestion) for suggestion in followups],
            "enrichments": [enrichment_to_dict(enrichment) for enrichment in enrichments.values()],
            "status": _status_to_dict(status_report),
        },
    )


def _tool_get_relationship_quality(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    contact_name = _optional_str(arguments.get("contact_name") or arguments.get("contact"))
    limit = _limit(arguments.get("limit"), default=20)
    min_score = _min_score(arguments.get("min_score"), default=45)
    profiles = _profiles_or_empty(db_path)
    profiles = _filter_profiles(profiles, contact_name)
    cards = build_relationship_quality_cards(
        db_path,
        profiles=profiles,
        as_of=_optional_str(arguments.get("as_of")),
        limit=limit,
        min_suggestion_score=min_score,
    )
    cards = _prioritize_exact_cards(cards, contact_name)
    markdown = render_relationship_quality_markdown(cards)
    return _tool_result(
        markdown,
        {
            "contact_name": contact_name,
            "count": len(cards),
            "cards": [quality_card_to_dict(card) for card in cards],
        },
    )


def _tool_get_relationship_dashboard(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    dashboard = build_relationship_dashboard(
        db_path,
        as_of=_optional_str(arguments.get("as_of") or arguments.get("date")),
        limit=_limit(arguments.get("limit"), default=8),
        min_score=_min_score(arguments.get("min_score"), default=45),
    )
    return _tool_result(
        render_relationship_dashboard_markdown(dashboard),
        {"dashboard": dashboard_to_dict(dashboard)},
    )


def _tool_list_relationship_sources(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    contact_name = _optional_str(arguments.get("contact_name") or arguments.get("contact"))
    source_type = _optional_str(arguments.get("source_type") or arguments.get("type"))
    limit = _limit(arguments.get("limit"), default=50)
    records = (
        list_relationship_sources(
            db_path,
            person_name=contact_name,
            source_type=source_type,
            limit=limit,
        )
        if db_path.exists()
        else []
    )
    return _tool_result(
        render_relationship_sources_markdown(records),
        {
            "contact_name": contact_name,
            "source_type": source_type,
            "count": len(records),
            "sources": [source_to_dict(record) for record in records],
        },
    )


def _tool_list_relationship_candidates(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    candidates = discover_relationship_candidates(
        db_path,
        min_confidence=_min_score(arguments.get("min_confidence"), default=45),
        limit=_limit(arguments.get("limit"), default=50),
    )
    status = _optional_str(arguments.get("status"))
    if status:
        candidates = [candidate for candidate in candidates if candidate.status == status]
    return _tool_result(
        render_candidates_markdown(candidates),
        {
            "status": status,
            "count": len(candidates),
            "candidates": [candidate_to_dict(candidate) for candidate in candidates],
        },
    )


def _tool_confirm_relationship_candidate(arguments: dict[str, Any]) -> dict[str, Any]:
    if (
        arguments.get("confirmed") is not True
        or arguments.get("confirmation_text") != "confirm relationship candidate"
    ):
        raise ValueError(
            "confirm_relationship_candidate requires confirmed=true "
            "and confirmation_text='confirm relationship candidate'"
        )
    candidate = confirm_relationship_candidate(
        _db_path(arguments),
        candidate_id=_optional_int(arguments.get("id") or arguments.get("candidate_id")),
        name=_optional_str(arguments.get("name")),
        source_chat=_optional_str(arguments.get("source_chat")),
        note=str(arguments.get("note") or ""),
        confirmed_at=_optional_str(arguments.get("confirmed_at")),
    )
    text = (
        "# 已确认人脉候选人\n\n"
        f"- 姓名：{candidate.name}\n"
        f"- 来源：{candidate.source_chat}\n"
        f"- 状态：{candidate.status}\n"
        f"- 时间：{candidate.confirmed_at or candidate.updated_at}\n"
    )
    if candidate.note:
        text += f"- 备注：{candidate.note}\n"
    return _tool_result(text, {"candidate": candidate_to_dict(candidate)})


def _tool_list_feedback(arguments: dict[str, Any]) -> dict[str, Any]:
    records = list_feedback(
        _db_path(arguments),
        person_name=_optional_str(arguments.get("contact_name") or arguments.get("contact")),
        limit=_limit(arguments.get("limit"), default=50),
    )
    return _tool_result(
        render_feedback_markdown(records),
        {"feedback": [feedback_to_dict(record) for record in records]},
    )


def _tool_record_feedback(arguments: dict[str, Any]) -> dict[str, Any]:
    if arguments.get("confirmed") is not True or arguments.get("confirmation_text") != "record local feedback":
        raise ValueError("record_feedback requires confirmed=true and confirmation_text='record local feedback'")
    contact_name = str(arguments.get("contact_name") or arguments.get("contact") or "").strip()
    action = str(arguments.get("action") or "").strip()
    record = record_feedback(
        _db_path(arguments),
        person_name=contact_name,
        action=action,
        note=str(arguments.get("note") or ""),
        until_at=_optional_str(arguments.get("until_at") or arguments.get("until")),
        created_at=_optional_str(arguments.get("created_at")),
    )
    text = (
        "# 已记录反馈\n\n"
        f"- 联系人：{record.person_name}\n"
        f"- 动作：{record.action}\n"
        f"- 时间：{record.created_at}\n"
    )
    if record.until_at:
        text += f"- 生效到：{record.until_at}\n"
    if record.note:
        text += f"- 备注：{record.note}\n"
    return _tool_result(text, {"feedback": feedback_to_dict(record)})


def _tool_list_recent_captures(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    limit = _limit(arguments.get("limit"), default=20)
    captures = _recent_captures(db_path, limit=limit)
    lines = ["# 最近采集记录", ""]
    if captures:
        for item in captures:
            image = f" image={item['image_path']}" if item["image_path"] else ""
            lines.append(
                f"- {item['captured_at']} / {item['contact_name']} / source={item['source']}{image}"
            )
    else:
        lines.append("暂无采集记录。")
    return _tool_result("\n".join(lines).rstrip() + "\n", {"captures": captures})


def _tool_get_capture_observations(arguments: dict[str, Any]) -> dict[str, Any]:
    db_path = _db_path(arguments)
    capture_id = _optional_int(arguments.get("capture_id"))
    if capture_id is None or capture_id < 1:
        raise ValueError("get_capture_observations requires a positive capture_id")
    if not db_path.exists():
        raise ValueError(f"capture not found: {capture_id}")
    with connect(db_path) as conn:
        if conn.execute("select 1 from captures where id = ?", (capture_id,)).fetchone() is None:
            raise ValueError(f"capture not found: {capture_id}")
    observations = list_ocr_observations(db_path, capture_id=capture_id)
    payload = [_observation_to_dict(observation) for observation in observations]
    lines = [f"# OCR 观察记录 {capture_id}", ""]
    if not payload:
        lines.append("暂无结构化 OCR observation。")
    else:
        for observation in payload:
            bbox = observation["bbox"] or "-"
            speaker = observation["speaker_candidate"] or "-"
            lines.append(
                f"- [{observation['sequence']}] {observation['text']} "
                f"confidence={observation['confidence'] if observation['confidence'] is not None else '-'} "
                f"bbox={bbox} speaker={speaker}"
            )
    return _tool_result(
        "\n".join(lines) + "\n",
        {"capture_id": capture_id, "observations": payload},
    )


def _tool_list_ocr_reviews(arguments: dict[str, Any]) -> dict[str, Any]:
    status = str(arguments.get("status") or "pending")
    max_confidence = arguments.get("max_confidence", 0.75)
    if max_confidence in (None, ""):
        max_confidence = None
    else:
        max_confidence = float(max_confidence)
    reviews = list_ocr_reviews(
        _db_path(arguments),
        status=status,
        max_confidence=max_confidence,
        limit=_limit(arguments.get("limit"), default=50),
    )
    return _tool_result(
        render_ocr_reviews(reviews, status=status, max_confidence=max_confidence),
        {
            "status": status,
            "max_confidence": max_confidence,
            "count": len(reviews),
            "reviews": [review_to_dict(review) for review in reviews],
        },
    )


def _tool_record_ocr_review(arguments: dict[str, Any]) -> dict[str, Any]:
    result = record_ocr_review(
        _db_path(arguments),
        observation_id=int(arguments.get("observation_id") or 0),
        action=str(arguments.get("action") or ""),
        corrected_text=_optional_str(arguments.get("corrected_text")),
        corrected_speaker=_optional_str(arguments.get("corrected_speaker")),
        note=str(arguments.get("note") or ""),
        confirmed=arguments.get("confirmed") is True,
        confirmation_text=_optional_str(arguments.get("confirmation_text")),
        reviewed_at=_optional_str(arguments.get("reviewed_at")),
    )
    review = result.review
    text = (
        "# 已记录 OCR 校正\n\n"
        f"- observation：{review.observation_id}\n"
        f"- capture：{review.capture_id}\n"
        f"- 动作：{result.action}\n"
        f"- 生效文本：{review.effective_text or '（已排除）'}\n"
        f"- capture 文本已更新：{'是' if result.capture_text_changed else '否'}\n"
    )
    return _tool_result(
        text,
        {"review": review_to_dict(review), "capture_text_changed": result.capture_text_changed},
    )


def _profiles_or_empty(db_path: Path) -> list[ContactProfile]:
    if not db_path.exists():
        return []
    return build_profiles(db_path)


def _suggestions_or_empty(db_path: Path, *, limit: int, min_score: int) -> list[Suggestion]:
    if not db_path.exists():
        return []
    return build_suggestions(db_path, limit=limit, min_score=min_score)


def _recent_captures(db_path: Path, *, limit: int) -> list[dict[str, Any]]:
    if not db_path.exists():
        return []
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            select c.id, p.name as contact_name, c.captured_at, c.source, c.image_path,
                   coalesce(c.corrected_text, c.clean_text) as clean_text,
                   (select count(*) from ocr_observations o where o.capture_id = c.id) as observation_count
            from captures c
            join people p on p.id = c.person_id
            order by c.captured_at desc, c.id desc
            limit ?
            """,
            (limit,),
        ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "contact_name": row["contact_name"],
            "captured_at": row["captured_at"],
            "source": row["source"],
            "image_path": row["image_path"],
            "preview": _preview(row["clean_text"]),
            "observation_count": int(row["observation_count"]),
        }
        for row in rows
    ]


def _render_followup_text(suggestion: Suggestion) -> str:
    source = f"\n- 来源群/会话：{', '.join(suggestion.source_chats)}" if suggestion.source_chats else ""
    return (
        "# 下一步跟进\n\n"
        f"- 联系人：{suggestion.person_name}{source}\n"
        f"- 动作：{suggestion.action}\n"
        f"- 分数：{suggestion.score}\n"
        f"- 跟进强度：{followup_strength_label(suggestion.score)}\n"
        f"- 最近互动：{suggestion.last_interaction_at}\n"
        f"- 原因：{suggestion.why}\n\n"
        f"草稿：{suggestion.draft}\n"
    )


def _tool_result(text: str, structured_content: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": text}],
        "structuredContent": structured_content,
        "isError": False,
    }


def _status_to_dict(report: StatusReport) -> dict[str, Any]:
    return {
        "db_path": str(report.db_path),
        "db_exists": report.db_exists,
        "contact_count": report.contact_count,
        "profile_count": report.profile_count,
        "capture_count": report.capture_count,
        "signal_count": report.signal_count,
        "latest_captured_at": report.latest_captured_at,
        "latest_contact": report.latest_contact,
        "latest_source": report.latest_source,
        "latest_image_path": report.latest_image_path,
        "captures_dir": str(report.captures_dir),
        "screenshot_count": report.screenshot_count,
        "log_file": str(report.log_file),
        "log_exists": report.log_exists,
        "log_line_count": report.log_line_count,
        "last_log_line": report.last_log_line,
        "watch_running": report.watch_running,
        "watch_processes": list(report.watch_processes),
        "top_followup": report.top_followup,
    }


def _profile_to_dict(profile: ContactProfile) -> dict[str, Any]:
    return {
        "name": profile.name,
        "kind": profile.kind,
        "source_chats": list(profile.source_chats),
        "last_seen_at": profile.last_seen_at,
        "last_interaction_at": profile.last_interaction_at,
        "recent_contents": list(profile.recent_contents),
        "speakers": list(profile.speakers),
        "links": list(profile.links),
        "files": list(profile.files),
        "identity_hints": list(profile.identity_hints),
        "organizations": list(profile.organizations),
        "signals": list(profile.signals),
    }


def _observation_to_dict(observation) -> dict[str, Any]:
    bbox = observation.bbox
    return {
        "sequence": observation.sequence,
        "text": observation.text,
        "confidence": observation.confidence,
        "bbox": (
            {
                "x": bbox[0],
                "y": bbox[1],
                "width": bbox[2],
                "height": bbox[3],
            }
            if bbox is not None
            else None
        ),
        "source": observation.source,
        "speaker_candidate": observation.speaker_candidate,
        "speaker_confidence": observation.speaker_confidence,
    }


def _suggestion_to_dict(suggestion: Suggestion) -> dict[str, Any]:
    return {
        "person_name": suggestion.person_name,
        "action": suggestion.action,
        "why": suggestion.why,
        "draft": suggestion.draft,
        "score": suggestion.score,
        "last_interaction_at": suggestion.last_interaction_at,
        "source_chats": list(suggestion.source_chats),
        "evidence_captured_at": suggestion.evidence_captured_at,
        "strength": followup_strength_label(suggestion.score),
    }


def _db_path(arguments: dict[str, Any]) -> Path:
    value = arguments.get("db_path")
    return resolve_mcp_path(
        value,
        default=default_db_path(Path.cwd()),
        label="db_path",
    )


def _optional_path(value: Any, *, base: Path | str | None = None) -> Path | None:
    if value is None or value == "":
        return None
    default = Path(str(value)).expanduser()
    return resolve_mcp_path(default, default=default, label="path", base=base)


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _limit(value: Any, *, default: int) -> int:
    if value is None or value == "":
        return default
    return max(1, min(100, int(value)))


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _min_score(value: Any, *, default: int) -> int:
    if value is None or value == "":
        return default
    return max(0, int(value))


def _preview(text: str, *, max_length: int = 160) -> str:
    preview = " ".join(line.strip() for line in text.splitlines() if line.strip())
    if len(preview) <= max_length:
        return preview
    return preview[: max_length - 1].rstrip() + "…"


def _prioritize_exact_cards(cards, query: str | None):
    if not query:
        return cards
    normalized_query = _normalize_match_text(query)
    return sorted(
        cards,
        key=lambda card: (
            0 if card.name.lower() == query.lower() or _normalize_match_text(card.name) == normalized_query else 1,
            -card.overall.score,
            card.name,
        ),
    )


def _normalize_match_text(value: str) -> str:
    return "".join(character for character in value.lower() if character.isalnum())


def _query_arguments(query: str) -> dict[str, str]:
    return {key: values[-1] for key, values in parse_qs(query).items() if values}


def _prompt_description(name: str) -> str:
    for prompt in MCP_PROMPTS:
        if prompt["name"] == name:
            return str(prompt["description"])
    return ""


def _result(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


if __name__ == "__main__":
    raise SystemExit(main())
