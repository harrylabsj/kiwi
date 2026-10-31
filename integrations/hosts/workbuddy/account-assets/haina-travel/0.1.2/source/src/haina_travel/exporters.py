"""固定交付导出器：三层交付 + 交付状态头 + 四种事实标签（设计第 5 章）。

只渲染白名单字段：证件号/订单码/密钥等敏感字段根本不进入导出文本。
地图链接只在传入已验证 MAP_EXPORT 结果时输出；否则明示"未生成"，不伪造链接。
CHECKED_PLANNING 语义：仅在所提供数据与已实现检查范围内通过，不是旅程订好。
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from .checks import open_issues
from .results import now_iso

FACT_LABEL = {'VERIFIED': '已核实', 'ESTIMATED': '估算',
              'UNCONFIRMED': '待确认', 'CONFLICTING': '有冲突'}
RESERVATION_LABEL = {
    'CONFIRMED': '已核实（供应商确认）', 'USER_REPORTED': '待确认（用户自述）',
    'NOT_BOOKED': '待确认（未预订）', 'UNKNOWN': '待确认', 'NOT_REQUIRED': '无需预约',
    'SOLD_OUT': '已售罄（不可作为主行程）'}
SEVERITY_LABEL = {'BLOCK': '阻断', 'NEEDS_CONFIRMATION': '待确认', 'WARN': '提示'}


def delivery_status(plan: dict, report: dict) -> str:
    """交付状态头只描述可交付性：BLOCKED / CONDITIONAL / CHECKED_PLANNING。
    （用户是否接受是 ACCEPTED 的事，不由本头表达。）"""
    if report['decision'] == 'BLOCKED':
        return 'BLOCKED'
    if report['decision'] == 'CHECKED_PLANNING':
        return 'CHECKED_PLANNING'
    return 'CONDITIONAL'


def _fen(amount: int) -> str:
    return f'{amount / 100:.2f}'   # 分→元保留两位：舍入到整元会虚报预算


def status_block(plan: dict, report: dict, map_links: dict | None) -> str:
    pending = open_issues(report)
    lines = [f'**交付状态：{delivery_status(plan, report)}**']
    if delivery_status(plan, report) == 'CHECKED_PLANNING':
        lines.append('（仅在所提供数据与已实现检查范围内通过；不表示已订好、未来事实不变或安全得到保证）')
    if map_links:
        lines.append(f'地图交接：{len(map_links)} 条已验证链接')
    else:
        lines.append('地图交接：未生成（不提供未经实际生成的链接）')
    if pending:
        lines.append(f'待确认/阻断项 {len(pending)} 条，见"必须先做的动作"。')
    lines.append(f'版本：v{plan["version"]}　检查时间：{report["checked_at"]}')
    return '\n'.join(lines)


def _actions(report: dict) -> list[str]:
    seen, out = set(), []
    for issue in sorted(open_issues(report), key=lambda i: (i['severity'], i['code'])):
        key = (issue['code'], issue['path'])
        if key in seen:
            continue
        seen.add(key)
        out.append(f'- [{SEVERITY_LABEL[issue["severity"]]}] {issue["code"]} @ {issue["path"]}：{issue["message"]}')
    return out


def render_overview(plan: dict, report: dict, map_links: dict | None = None) -> str:
    req = plan['request']
    highlights = []
    for day in plan['days']:
        for s in day['slots']:
            if s.get('highlight'):
                highlights.append(f'{day["date"]} {s["highlight"]}')
    top = highlights[:3] or ['（无高亮——请在手册中查看每日安排）']
    lodg = '、'.join(
        next((p['name'] for p in plan['places'] if p['id'] == st['place_id']), st['place_id'])
        for st in plan['lodgings'])
    lines = [
        f'# {plan["theme"] or "旅行计划"}｜一页总览',
        status_block(plan, report, map_links),
        '',
        f'- 日期：{req["start_date"]} 至 {req["end_date"]}（{req["timezone"]}）',
        f'- 同行人数：{req["party_size"]}　预算口径：{req["budget_scope"]}',
        f'- 预算区间：¥{_fen(plan["budget"]["total_low_fen"])} – ¥{_fen(plan["budget"]["total_high_fen"])}'
        f'（上限 ¥{_fen(req["budget_cap_fen"])}）',
        f'- 住宿：{lodg or "未安排"}',
        f'- 目的地：{req["destination"]}',
        '',
        '## 最值得期待',
        *[f'{i + 1}. {h}' for i, h in enumerate(top)],
        '',
        '## 必须先做的动作',
        *(_actions(report) or ['- 无（在已实现检查范围内无待确认/阻断项）']),
        '',
        '## 风险与边界',
        *[f'- {t}' for t in report['limitations']],
    ]
    return '\n'.join(lines) + '\n'


def render_daily(plan: dict, report: dict, map_links: dict | None = None) -> str:
    evid = {e['id']: e for e in plan['evidence']}
    places = {p['id']: p for p in plan['places']}
    lines = [f'# 每日安排｜{plan["theme"] or "旅行计划"}', status_block(plan, report, map_links), '']
    for day in plan['days']:
        theme_note = plan['change_summary'] if plan['change_summary'] else ''
        lines.append(f'## {day["date"]}')
        if theme_note:
            lines.append(f'变更摘要：{theme_note}')
        for s in day['slots']:
            place = places.get(s['place_id'], {})
            open_note = ''
            if s['open_from'] and s['open_until']:
                open_note = f'（开放 {s["open_from"][11:16]}–{s["open_until"][11:16]}'
                ev = evid.get(s['opening_evidence_id'] or '')
                if ev:
                    open_note += f'，{FACT_LABEL[ev["status"]]}'
                open_note += '）'
            res = RESERVATION_LABEL.get(s['reservation_status'], s['reservation_status'])
            lines.append(
                f'- {s["start"][11:16]}–{s["end"][11:16]} {s["kind"]}｜{place.get("name", s["place_id"])}'
                f'{open_note}｜预约：{res}'
                + (f'｜步行约 {s["indoor_walk_m"]}m' if s['indoor_walk_m'] is not None else ''))
        legs = {l['id']: l for l in plan['legs']}
        for a, b in zip(day['slots'], day['slots'][1:]):
            leg = next((l for l in legs.values() if l['from_slot_id'] == a['id']
                        and l['to_slot_id'] == b['id']), None)
            if leg:
                lines.append(f'  → 交通 {leg["mode"]} 约 {leg["duration_low_min"]}–{leg["duration_high_min"]} 分钟'
                             f'（含缓冲 {leg["buffer_min"]} 分钟，{leg["estimate_basis"]}）')
        walk = day['daily_walk_m']
        lines.append(f'  当天步行：{"约 " + str(walk) + " m" if walk is not None else "存在未知量，无法给出精确日总量"}')
        lines.append('')
    return '\n'.join(lines) + '\n'


def render_manual(plan: dict, report: dict, map_links: dict | None = None) -> str:
    evid = {e['id']: e for e in plan['evidence']}
    places = {p['id']: p for p in plan['places']}
    lines = [f'# 完整手册｜{plan["theme"] or "旅行计划"}',
             status_block(plan, report, map_links), '']

    lines.append('## 地点说明')
    for p in plan['places']:
        ev = evid.get(p['identity_evidence_id'], {})
        lines.append(f'- {p["name"]}（{p["category"]}）{p["address"]}｜身份：{FACT_LABEL.get(ev.get("status"), "待确认")}'
                     f'｜来源：{ev.get("source_type", "未知")}')
    lines.append('')

    for day in plan['days']:
        lines.append(f'## {day["date"]} 详细')
        for s in day['slots']:
            place = places.get(s['place_id'], {})
            lines.append(f'### {s["start"][11:16]}–{s["end"][11:16]} {place.get("name", s["place_id"])}')
            if s['rationale']:
                lines.append(f'- 为什么适合：{s["rationale"]}')
            if s['highlight']:
                lines.append(f'- 体验亮点：{s["highlight"]}')
            if s['indoor_walk_m'] is not None:
                lines.append(f'- 内部步行：约 {s["indoor_walk_m"]} m（已知量）')
            if s['reservation_status'] != 'NOT_REQUIRED':
                lines.append(f'- 预约状态：{RESERVATION_LABEL.get(s["reservation_status"])}')
            ev = evid.get(s['opening_evidence_id'] or '')
            if ev:
                lines.append(f'- 开放依据：{FACT_LABEL[ev["status"]]}｜{ev["claim"]}')
        lines.append('')

    lines.append('## 住宿')
    for st in plan['lodgings']:
        hotel = places.get(st['place_id'], {})
        lines.append(f'- {hotel.get("name", st["place_id"])}：{st["check_in_date"]} 入住，{st["check_out_date"]} 离店'
                     f'（{st["rooms"]} 间 × 容纳 {st["capacity_per_room"]} 人）｜'
                     f'{"已订（供应商确认）" if st["booking_status"] == "CONFIRMED" else "尚未供应商确认，不得称为已订好"}')
    lines.append('')

    lines.append('## 预算明细（人民币分→元）')
    for item in plan['budget']['items']:
        label = {'PAID_USER_REPORTED': '已付（用户自述）', 'QUOTE': '报价', 'ESTIMATE': '估算'}[item['status']]
        lines.append(f'- {item["category"]} {item["unit"]} × {item["quantity"]}：'
                     f'¥{_fen(item["amount_low_fen"])} – ¥{_fen(item["amount_high_fen"])}（{label}）'
                     + (f'｜{item["notes"]}' if item.get('notes') else ''))
    lines.append(f'- 合计：¥{_fen(plan["budget"]["total_low_fen"])} – ¥{_fen(plan["budget"]["total_high_fen"])}'
                 f'；备用金包含在明细中（可调，不默认恰好够用）')
    lines.append('')

    lines.append('## 核验说明')
    for e in plan['evidence']:
        lines.append(f'- {FACT_LABEL[e["status"]]}｜{e["subject_id"]}｜{e["claim_type"]}｜{e["claim"]}'
                     f'｜查询 {e["retrieved_at"]}｜最迟复查 {e["expires_at"]}')
    lines.append('')
    lines.append('## 限制')
    lines.extend(f'- {t}' for t in report['limitations'])
    if map_links:
        lines.append('## 地图交接（已验证生成）')
        for k, v in map_links.items():
            lines.append(f'- {k}: {v}')
    return '\n'.join(lines) + '\n'


def export_all(plan: dict, report: dict, out_dir: Path,
               map_links: dict | None = None) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    files = {'overview.md': render_overview(plan, report, map_links),
             'daily.md': render_daily(plan, report, map_links),
             'manual.md': render_manual(plan, report, map_links)}
    for name, text in files.items():
        target = out / f'v{plan["version"]}-{name}'
        if target.exists():
            raise FileExistsError(f'拒绝覆盖导出文件：{target}')
        target.write_text(text, encoding='utf-8')
    index_path = out / 'export-index.json'
    entry = {'trip_id': plan['trip_id'], 'version': plan['version'],
             'exported_at': now_iso(), 'files': sorted(files),
             'status': delivery_status(plan, report)}
    index = []
    if index_path.is_file():
        index = json.loads(index_path.read_text(encoding='utf-8'))
    index.append(entry)
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return entry
