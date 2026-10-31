"""检查服务：加载冻结的参考检查器（03_reference/validator.py）并包装成服务接口。

单一事实源：规则实现不复制，直接 import 参考文件（同版基线，哈希受
MANIFEST.json 保护）。引擎只补三类东西：严格格式守卫、决策→状态推导、
限制说明。这里产出的报告才允许写 CHECKED；模型自报不生效。
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

from .schemas import assert_format_checker_strict

_REPORT_LIMITS = [
    '仅检查输入数据的一致性；不证明原始来源真实、语义正确或未来仍有效。',
    '未执行联网、WorkBuddy联调、商家核验、真实路线测量、付款或预订。',
    '连续步行仅做单段超限检查；完整连续负荷、餐食禁忌、天气安全与替代路线仍需生产实现及人工复核。',
]


def _load_reference_validator():
    here = Path(__file__).resolve()
    # ① 开发树：仓库的 03_reference/validator.py（规则单一事实源，受清单哈希保护）；
    # ② 打包树：引擎目录旁的 reference_validator.py（构建时从①复制，哈希进清单）。
    for parent in here.parents:
        candidate = parent / '03_reference' / 'validator.py'
        if candidate.is_file():
            return _exec_module(candidate)
    packaged = here.parent.parent / 'reference_validator.py'
    if packaged.is_file():
        return _exec_module(packaged)
    raise FileNotFoundError('找不到参考检查器（03_reference/ 或打包 reference_validator.py）')


def _exec_module(candidate: Path):
    spec = importlib.util.spec_from_file_location('hana_reference_validator', candidate)
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault('hana_reference_validator', module)
    spec.loader.exec_module(module)
    return module


_ref = _load_reference_validator()


def validate_plan_report(plan: dict[str, Any], now: str | None = None) -> dict:
    """跑全部结构化检查，返回 validation_report 同构 dict。"""
    assert_format_checker_strict()
    if now is None:
        from .results import now_iso
        now = now_iso()
    report = _ref.validate_plan(plan, now)
    report['limitations'] = list(_REPORT_LIMITS)
    from .schemas import validate_schema
    validate_schema('validation_report', report)
    return report


def validate_change_report(old: dict, new: dict, change: dict) -> list[dict]:
    """变更提案授权/范围检查；调用方仍必须对 new 跑 validate_plan_report。"""
    assert_format_checker_strict()
    return _ref.validate_change(old, new, change)


def blocking_issues(report: dict) -> list[dict]:
    return [i for i in report['issues'] if i['severity'] == 'BLOCK']


def open_issues(report: dict) -> list[dict]:
    return [i for i in report['issues'] if i['severity'] in ('BLOCK', 'NEEDS_CONFIRMATION')]


def issue_codes(report: dict) -> set[str]:
    return {i['code'] for i in report['issues']}
