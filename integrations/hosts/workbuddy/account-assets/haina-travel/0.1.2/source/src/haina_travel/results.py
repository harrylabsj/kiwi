"""ToolResult 统一信封（tool_result.schema.json 同版）。

所有外部能力（PLACE_SEARCH/PLACE_DETAIL/ROUTE/WEB_READ/WEATHER/MAP_EXPORT）
返回此结构；PARTIAL 不等于 OK，失败保留 request_id 与脱敏追踪。
"""
from __future__ import annotations

from datetime import datetime, timezone

SCHEMA_VERSION = '0.1.0'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def make_result(tool: str, request_id: str, status: str, data=None, *,
                evidence_ids=None, error_code=None, retryable=False,
                cost_microunits=0, billing_currency='CNY', provider_trace_id=None,
                retrieved_at=None) -> dict:
    result = {
        'schema_version': SCHEMA_VERSION,
        'request_id': request_id,
        'tool': tool,
        'status': status,
        'retrieved_at': retrieved_at or now_iso(),
        'data': data,
        'evidence_ids': evidence_ids or [],
        'error_code': error_code,
        'retryable': retryable,
        'cost_microunits': cost_microunits,
        'billing_currency': billing_currency,
        'provider_trace_id': provider_trace_id,
    }
    from .schemas import validate_schema
    validate_schema('tool_result', result)
    return result


def is_ok(result: dict) -> bool:
    """只有 OK 算成功；PARTIAL 必须由调用方按缺什么显式处理。"""
    return result['status'] == 'OK'
