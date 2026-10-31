"""契约加载与 Schema 校验。

设计 9.1 的硬要求：格式检查必须显式启用，date-time 不能当普通字符串。
jsonschema 的 date-time FormatChecker 在缺 rfc3339-validator 时会静默降级，
这里启动即自检，不满足就 fail-fast，绝不产出"看似通过"的报告。
"""
from __future__ import annotations

import functools
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError
from referencing import Registry, Resource

BASE = 'https://schemas.example.invalid/haina-travel/0.1.0/'
NAMES = ('trip_request', 'evidence', 'place', 'itinerary',
         'change_request', 'validation_report', 'tool_result', 'benchmark_run')


def _contracts_dir() -> Path:
    here = Path(__file__).resolve()
    # ① 开发树：仓库的 02_contracts/；② 打包树：engine/02_contracts（同名，供冻结检查器共用）
    for parent in here.parents:
        candidate = parent / '02_contracts'
        if (candidate / 'itinerary.schema.json').is_file():
            return candidate
    raise FileNotFoundError('找不到契约目录（02_contracts/）')


@functools.lru_cache(maxsize=1)
def load_contracts() -> dict[str, dict]:
    d = _contracts_dir()
    out = {}
    for name in NAMES:
        import json
        out[name] = json.loads((d / f'{name}.schema.json').read_text(encoding='utf-8'))
    return out


def assert_format_checker_strict() -> None:
    """date-time 必须按 RFC3339 严格校验；宽松降级直接拒绝服务。"""
    checker = FormatChecker()
    ok_bad = checker.conforms('2026-10-01T09:00:00', 'date-time')   # 无时区：必须判 False
    ok_good = checker.conforms('2026-10-01T09:00:00+08:00', 'date-time')
    if ok_bad or not ok_good:
        raise RuntimeError(
            'date-time 格式检查未按 RFC3339 严格校验（缺 rfc3339-validator？）。'
            '拒绝运行，避免把无时区时间戳当合法值放行。')


@functools.lru_cache(maxsize=1)
def _registry() -> Registry:
    resources = [(s['$id'], Resource.from_contents(s)) for s in load_contracts().values()]
    return Registry().with_resources(resources)


def schema_errors(name: str, data) -> list[str]:
    """返回可读错误列表；空列表 = 通过。"""
    assert_format_checker_strict()
    validator = Draft202012Validator(
        load_contracts()[name], registry=_registry(), format_checker=FormatChecker())
    return [f"/{'/'.join(map(str, e.absolute_path))}: {e.message}"
            for e in validator.iter_errors(data)]


def validate_schema(name: str, data) -> None:
    errors = schema_errors(name, data)
    if errors:
        raise ValueError(f'{name} Schema 校验失败：{errors[:5]}')
