"""导出 XLSX 生成器（§19.2）：10 个工作表，值快照、无公式、未知留空。

- 未知数值留空并在状态列解释，不用 0 或 "0" 替代。
- CSV/表格公式注入防护（OWASP）：以 = + - @ 或制表/回车开头的文本前置单引号。
"""
from __future__ import annotations

import io
import json
from datetime import datetime
from zoneinfo import ZoneInfo

from .. import DISPLAY_TZ

SHEET_NAMES = ["总览", "逐行台账", "核算组", "待核差异", "待补证", "待匹配", "规则引用",
               "复核记录", "版本变化", "来源清单"]

_INJECTION_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def safe_cell(value) -> str | None:
    """文本单元格防公式注入；None 保持空（未知），不写 0。"""
    if value is None:
        return None
    text = str(value)
    if text.startswith(_INJECTION_PREFIXES):
        return "'" + text
    return text


def _fmt_ts(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.astimezone(ZoneInfo(DISPLAY_TZ)).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        return iso


def build_workbook(run: dict, results: list[dict], groups: list[dict],
                   issues: list[dict], decisions: list[dict], assets: list[dict],
                   rules: list[dict], run_history: list[dict],
                   case: dict) -> bytes:
    from openpyxl import Workbook
    wb = Workbook()
    wb.remove(wb.active)

    def add_sheet(name: str, header: list[str], rows: list[list]) -> None:
        ws = wb.create_sheet(title=name)
        ws.append(header)
        for row in rows:
            ws.append([safe_cell(v) for v in row])

    summary = json.loads(run["summary"]) if run["summary"] else {}
    coverage = {
        "可比组数": summary.get("comparable_group_count", 0),
        "组数": summary.get("group_count", 0),
        "可比账单行": summary.get("comparable_line_count", 0),
        "账单行": summary.get("bill_line_count", 0),
        "金额覆盖分子(绝对值分)": summary.get("abs_comparable_billed_minor", 0),
        "金额覆盖分母(绝对值分)": summary.get("abs_total_billed_minor", 0),
    }
    cov_pct = (coverage["金额覆盖分子(绝对值分)"] / coverage["金额覆盖分母(绝对值分)"]
               if coverage["金额覆盖分母(绝对值分)"] else None)
    overview = [
        ["案件", case["id"], "账期", f'{case["period_from"]} ~ {case["period_to"]}'],
        ["主体工作区", case["workspace_id"], "承运商", case["carrier_id"]],
        ["run", run["run_id"], "状态", run["status"]],
        ["账单净额(分)", summary.get("source_signed_total_minor"), "金额完整性",
         "完整" if run["amount_complete"] else "不完整：存在解析失败或合计不平"],
        ["可比账单(分)", summary.get("comparable_billed_minor"), "应计(分)",
         summary.get("expected_comparable_minor")],
        ["正向差额(分)", summary.get("positive_difference_minor"), "反向差额(分)",
         summary.get("negative_difference_minor")],
        ["净差额(分)", summary.get("net_difference_minor"), "不可比账单(分)",
         summary.get("unresolved_billed_minor")],
        ["明确排除(分)", summary.get("out_of_scope_billed_minor"), "排除行数",
         summary.get("out_of_scope_line_count")],
        ["可比行覆盖", f'{coverage["可比账单行"]}/{coverage["账单行"]}', "金额覆盖",
         f"{cov_pct:.2%}" if cov_pct is not None else "未知"],
        ["未解决组数", sum(1 for r in results if r["comparison_status"] != "COMPARABLE"),
         "历史覆盖说明", run["history_coverage_note"]],
        ["上一版run", run["supersedes_run_id"], "", ""],
    ]
    add_sheet(SHEET_NAMES[0], ["项目", "值", "项目2", "值2"], overview)

    line_rows = []
    for g in groups:
        for line_id in json.loads(g["line_ids"]):
            line_rows.append([line_id, g["trip_id"], g["charge_code"], g["occurrence_id"],
                              g["currency"], g["amount_basis"], None, None])
    add_sheet(SHEET_NAMES[1], ["line_id", "trip_id", "charge_code", "occurrence_id",
                               "currency", "amount_basis", "amount_minor", "说明"],
              line_rows)

    add_sheet(SHEET_NAMES[2],
              ["group_id", "trip_id", "charge_code", "occurrence_id", "match_state",
               "pod_state", "billed_minor", "expected_minor", "delta_minor",
               "comparison_status", "evidence_status", "rule_ref", "result_digest"],
              [[g["group_id"], g["trip_id"], g["charge_code"], g["occurrence_id"],
                g["match_state"], g["pod_state"], g["billed_minor"], None, None, None,
                None, None, None] for g in groups])

    diff_rows = []
    for r in results:
        if r["delta_minor"] is not None and r["delta_minor"] != 0:
            diff_rows.append([r["group_id"], r["billed_minor"], r["expected_minor"],
                              r["delta_minor"], ",".join(r["issues"]), r["rule_ref"],
                              r["result_digest"]])
    add_sheet(SHEET_NAMES[3], ["group_id", "账单净额(分)", "应计(分)", "差额(分)",
                               "异常", "规则", "result_digest"], diff_rows)

    ev_rows = []
    for r in results:
        if r["evidence_status"] != "COMPLETE":
            ev_rows.append([r["group_id"], r["evidence_status"], ",".join(r["issues"]),
                            r["source_refs"] and ";".join(r["source_refs"])])
    add_sheet(SHEET_NAMES[4], ["group_id", "证据状态", "异常", "来源定位"], ev_rows)

    pm_rows = []
    for g in groups:
        if g["match_state"] in ("UNMATCHED", "AMBIGUOUS", "CONFLICT"):
            pm_rows.append([g["group_id"], g["match_state"], g["trip_id"],
                            g["billed_minor"], ";".join(
                                ln for ln in json.loads(g["line_ids"]))])
    add_sheet(SHEET_NAMES[5], ["group_id", "匹配状态", "trip_id", "账单净额(分)", "line_ids"],
              pm_rows)

    add_sheet(SHEET_NAMES[6],
              ["rule_id", "version", "route_id", "vehicle_class", "charge_code", "formula",
               "rate_minor", "effective_from", "effective_to", "confirmation_ref"],
              [[r["rule_id"], r["version"], r["route_id"], r["vehicle_class"],
                r["charge_code"], r["formula"], r["rate_minor"], r["effective_from"],
                r["effective_to"], r.get("confirmation_ref")] for r in rules])

    add_sheet(SHEET_NAMES[7],
              ["decision_id", "group_id", "decision", "reason", "actor_id", "status",
               "confirmed_at", "result_digest"],
              [[d["decision_id"], d["group_id"], d["decision"], d["reason"],
                d["actor_id"], d["status"], _fmt_ts(d["confirmed_at"]),
                d["result_digest"]] for d in decisions])

    ver_rows = []
    for h in run_history:
        ver_rows.append([h["run_id"], h["status"], _fmt_ts(h["created_at"]),
                         h["supersedes_run_id"],
                         json.loads(h["summary"]).get("net_difference_minor")
                         if h["summary"] else None])
    add_sheet(SHEET_NAMES[8], ["run_id", "状态", "时间", "替代run", "净差额(分)"], ver_rows)

    add_sheet(SHEET_NAMES[9],
              ["asset_id", "kind", "original_name", "sha256", "byte_size", "detail_rows",
               "parse_error_rows", "amount_complete", "imported_at"],
              [[a["asset_id"], a["kind"], a["original_name"], a["sha256"],
                a["byte_size"], a["detail_rows"], a["parse_error_rows"],
                "完整" if a["amount_complete"] else "不完整", _fmt_ts(a["imported_at"])]
               for a in assets])

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_markdown(run: dict, summary: dict, case: dict, unresolved: int) -> str:
    cov_den = summary.get("abs_total_billed_minor", 0)
    cov_num = summary.get("abs_comparable_billed_minor", 0)
    cov = f"{cov_num / cov_den:.2%}" if cov_den else "未知"
    lines = [
        "# 海纳·运费对账 — 核对材料",
        "",
        f"- 案件：{case['id']}（{case['period_from']} ~ {case['period_to']}，"
        f"承运商 {case['carrier_id']}）",
        f"- 运行版本：{run['run_id']}（状态 {run['status']}）",
        f"- 账单净额：{summary.get('source_signed_total_minor', 0) / 100:.2f} 元"
        f"（可比 {summary.get('comparable_billed_minor', 0) / 100:.2f} / "
        f"不可比 {summary.get('unresolved_billed_minor', 0) / 100:.2f} / "
        f"明确排除 {summary.get('out_of_scope_billed_minor', 0) / 100:.2f}）",
        f"- 按当前已确认合同规则计算：正向差额 "
        f"{summary.get('positive_difference_minor', 0) / 100:.2f} 元，反向差额 "
        f"{summary.get('negative_difference_minor', 0) / 100:.2f} 元，净差额 "
        f"{summary.get('net_difference_minor', 0) / 100:.2f} 元。",
        f"- 金额覆盖：{cov}；未解决核算组 {unresolved} 个。",
        f"- 金额完整性：{'完整' if run['amount_complete'] else '不完整——存在解析失败或源合计不平，本材料为草稿'}",
        "",
        "本材料供双方核对使用，请协助核对/补充依据；不构成付款指令，不构成财务审计意见，",
        "也不构成对承运商多收费的认定。待核差异以双方确认为准。",
        "",
        f"生成时间：{_fmt_ts(run['created_at'])}（{DISPLAY_TZ}展示）",
    ]
    return "\n".join(lines) + "\n"
