"""三任务编排：PLAN（装配+检查+修复）、AUDIT（体检）、REPLAN（局部改程）。

边界（设计第 6/7 章）：
- 模型负责选点与体验描述（blueprint 的输入）；本模块只做确定性装配、
  交通/预算计算、检查与有限修复（≤2 轮），不假装全局最优；
- 固定项（已订交通、住宿、关键预约）先落位；软偏好在硬约束满足后比较；
- 修复不动的阻断项诚实保留，交付 CONDITIONAL/BLOCKED，不伪称通过。
"""
from __future__ import annotations

import copy
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .checks import issue_codes, open_issues, validate_change_report, validate_plan_report
from .guards import TaskBudget
from .results import now_iso

SCHEMA_VERSION = '0.1.0'
MEAL_WINDOWS = (('11:45', '13:45'), ('17:45', '19:45'))   # 午/晚可解释默认窗口
PLACE_CATEGORIES = ('ATTRACTION', 'RESTAURANT', 'HOTEL', 'TRANSPORT', 'OTHER')
PLACE_KINDS = ('ATTRACTION', 'MEAL', 'REST', 'ARRIVAL', 'DEPARTURE', 'FREE_TIME')


def validate_blueprint(blueprint: dict) -> None:
    """blueprint 前置校验：缺地点身份字段直接拒绝，不让半成品进入检查循环。
    （同名跨 anchor/candidate 允许：pid_for 按名去重，used_candidates 防重复排入。）
    """

    def check_place(cand: dict, where: str) -> None:
        for field in ('name', 'category', 'city', 'address'):
            if not str(cand.get(field, '')).strip():
                raise ValueError(f'{where} 缺少必填字段 {field}（地点身份不完整，先补齐再装配）')
        if cand['category'] not in PLACE_CATEGORIES:
            raise ValueError(f'{where} category 非法：{cand["category"]}')

    for i, anch in enumerate(blueprint.get('anchors', [])):
        check_place(anch['place'], f'anchors[{i}]')
        if anch['kind'] not in ('ARRIVAL', 'DEPARTURE', 'ATTRACTION', 'REST', 'LODGING'):
            raise ValueError(f'anchors[{i}] kind 非法：{anch["kind"]}')
    for i, cand in enumerate(blueprint.get('candidates', [])):
        check_place(cand, f'candidates[{i}]')
        if cand.get('kind') not in PLACE_KINDS:
            raise ValueError(f'candidates[{i}] kind 非法：{cand.get("kind")}')


# ---------- 证据与时间策略（设计 7.2 初始复查策略） ----------
def expires_for(claim_type: str, retrieved_at: str, tz: ZoneInfo) -> str:
    at = datetime.fromisoformat(retrieved_at).astimezone(tz)
    hours = {'IDENTITY': 24 * 30, 'OPENING': 24, 'RESERVATION': 24,
             'ROOM_POLICY': 24, 'PRICE': 0, 'ROUTE': 0}.get(claim_type, 24)
    if hours == 0:   # 价格/路线只代表查询时刻：当天末尾前须复查
        return at.replace(hour=23, minute=59, second=59, microsecond=0).isoformat()
    return (at + timedelta(hours=hours)).isoformat()


def mk_evidence(eid: str, subject_id: str, claim_type: str, claim: str, *,
                source_type: str, source_uri: str, retrieved_at: str, tz: ZoneInfo,
                valid_from: str, valid_until: str, date_specific: bool,
                status: str) -> dict:
    return {'id': eid, 'subject_id': subject_id, 'claim_type': claim_type,
            'claim': claim, 'source_type': source_type, 'source_uri': source_uri,
            'retrieved_at': retrieved_at, 'expires_at': expires_for(claim_type, retrieved_at, tz),
            'valid_from': valid_from, 'valid_until': valid_until,
            'date_specific': date_specific, 'status': status,
            'provenance_ref': source_uri}


# ---------- 小构造器 ----------
def _slot(slot_id: str, place_id: str, kind: str, start: str, end: str, *, locked=False,
          priority='PREFERRED', availability='OPEN', open_from=None, open_until=None,
          opening_evidence_id=None, reservation_status='NOT_REQUIRED',
          booking_evidence_id=None, reservation_evidence_id=None, indoor_walk_m=None,
          rationale='', highlight='', fallback_slot_id=None) -> dict:
    return {'id': slot_id, 'place_id': place_id, 'kind': kind, 'start': start, 'end': end,
            'locked': locked, 'priority': priority, 'availability': availability,
            'open_from': open_from, 'open_until': open_until,
            'opening_evidence_id': opening_evidence_id,
            'reservation_status': reservation_status,
            'booking_evidence_id': booking_evidence_id,
            'reservation_evidence_id': reservation_evidence_id,
            'indoor_walk_m': indoor_walk_m, 'rationale': rationale,
            'highlight': highlight, 'fallback_slot_id': fallback_slot_id}


def _mk_leg(leg_id: str, a: dict, b: dict, mode: str, low: int, high: int, buffer_min: int,
            walk_m, evidence_id: str, basis: str) -> dict:
    return {'id': leg_id, 'from_slot_id': a['id'], 'to_slot_id': b['id'], 'mode': mode,
            'duration_low_min': low, 'duration_high_min': high, 'buffer_min': buffer_min,
            'walk_m': walk_m, 'evidence_id': evidence_id, 'estimate_basis': basis}


def _parse_hhmm(day_date: str, hhmm: str, tz: ZoneInfo) -> datetime:
    return datetime.fromisoformat(f'{day_date}T{hhmm}:00+08:00').astimezone(tz)


def _iso(at: datetime) -> str:
    return at.isoformat(timespec='seconds')


def _day_bounds(day_date: str, tz: ZoneInfo) -> tuple[str, str]:
    return (f'{day_date}T00:00:00+08:00', f'{day_date}T23:59:59+08:00')


# ---------- PLAN：从 blueprint 确定性装配 ----------
def build_plan(blueprint: dict, provider, budget: TaskBudget | None = None,
               now: str | None = None) -> tuple[dict, dict, dict]:
    """blueprint → (plan, report, meta)。固定项先落位，启发式补全，≤2 轮修复。"""
    now = now or now_iso()
    request = blueprint['request']
    if request.get('timezone') != 'Asia/Shanghai':
        raise ValueError('首版仅支持 Asia/Shanghai：装配的餐窗/日界/住宿政策与检查器都按 +08:00 钉死；'
                         '其他时区须先整体升版改造，不得静默错位。')
    validate_blueprint(blueprint)
    hints: dict[str, dict] = {}
    for anch in blueprint.get('anchors', []):
        hints.setdefault(anch['place']['name'], {}).update(anch.get('hints') or {})
    for cand in blueprint.get('candidates', []):
        hints.setdefault(cand['name'], {}).update(cand.get('hints') or {})
    synthetic_world = blueprint.get('data_origin', 'SYNTHETIC') == 'SYNTHETIC'
    tz = ZoneInfo(request['timezone'])
    start = datetime.fromisoformat(request['start_date']).date()
    end = datetime.fromisoformat(request['end_date']).date()
    dates = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
    evid_by_id: dict[str, dict] = {}

    def add_evid(ev: dict) -> str:
        evid_by_id[ev['id']] = ev
        return ev['id']

    places: dict[str, dict] = {}
    counter = {'n': 0}

    def pid_for(cand: dict) -> str:
        for p in places.values():
            if p['name'] == cand['name']:
                return p['id']
        counter['n'] += 1
        cid = f'p-{counter["n"]:02d}'
        origin = cand.get('origin', 'SYNTHETIC')
        ev = mk_evidence(f'ev-id-{cid}', cid, 'IDENTITY',
                         f'地点身份：{cand["name"]}（{cand.get("address", "")}）',
                         source_type='SYNTHETIC' if origin == 'SYNTHETIC' else 'MAP_PROVIDER',
                         source_uri=cand.get('source_uri', 'blueprint'),
                         retrieved_at=now, tz=tz, valid_from=now,
                         valid_until=(datetime.fromisoformat(now) + timedelta(days=30)).isoformat(),
                         date_specific=False, status='VERIFIED')
        add_evid(ev)
        places[cid] = {
            'id': cid,
            'provider': cand.get('provider', 'blueprint' if origin == 'SYNTHETIC' else 'amap'),
            'provider_place_id': str(cand.get('provider_place_id', cid)),
            'name': cand['name'], 'city': cand['city'], 'address': cand['address'],
            'category': cand['category'],
            'coordinate_system': 'SYNTHETIC' if origin == 'SYNTHETIC'
            else cand.get('coordinate_system', 'GCJ02'),
            'lng': cand.get('lng', 0), 'lat': cand.get('lat', 0),
            'identity_evidence_id': ev['id'], 'tags': cand.get('tags', [])}
        return cid

    def opening_evidence(sid: str, place_id: str, cand_or_anch: dict, day_date: str) -> str | None:
        open_from = cand_or_anch.get('open_from')
        if not open_from:
            return None
        lo, hi = _day_bounds(day_date, tz)
        ev = mk_evidence(f'ev-open-{sid}', place_id, 'OPENING',
                         f'开放时间 {open_from[11:16]}–{cand_or_anch["open_until"][11:16]}'
                         f'（{"候选声明" if "kind" in cand_or_anch else "锚点声明"}）',
                         source_type='SYNTHETIC' if synthetic_world else
                         ('MAP_PROVIDER' if cand_or_anch.get('origin') != 'SYNTHETIC' else 'USER'),
                         source_uri=cand_or_anch.get('source_uri', 'blueprint'),
                         retrieved_at=now, tz=tz, valid_from=lo, valid_until=hi,
                         date_specific=True,
                         status='VERIFIED' if synthetic_world else 'UNCONFIRMED')
        add_evid(ev)
        return ev['id']

    def reservation_evidence(sid: str, place_id: str, res_status: str, day_date: str,
                             from_anchor: bool) -> str:
        lo, hi = _day_bounds(day_date, tz)
        claim = {'NOT_REQUIRED': '候选声明：无需预约', 'USER_REPORTED': '用户自述：已预约（未取得供应商确认）',
                 'CONFIRMED': '供应商确认：已预约'}.get(res_status, f'预约状态 {res_status}，待确认')
        if res_status == 'CONFIRMED':
            source, status = ('SYNTHETIC' if synthetic_world else 'AUTHORIZED_PLATFORM'), 'VERIFIED'
        elif res_status == 'USER_REPORTED':
            source, status = 'USER', 'UNCONFIRMED'
        else:
            source = 'SYNTHETIC' if synthetic_world and not from_anchor else 'USER'
            status = 'VERIFIED' if synthetic_world and not from_anchor else 'UNCONFIRMED'
        ev = mk_evidence(f'ev-res-{sid}', place_id, 'RESERVATION', claim,
                         source_type=source, source_uri='blueprint',
                         retrieved_at=now, tz=tz, valid_from=lo, valid_until=hi,
                         date_specific=True, status=status)
        add_evid(ev)
        return ev['id']

    days: list[dict] = []
    lodgings: list[dict] = []
    used_candidates: set[str] = set()
    pending_notes: list[str] = []
    candidates = list(blueprint.get('candidates', []))

    # 1) 住宿锚点
    for anch in blueprint.get('anchors', []):
        if anch['kind'] != 'LODGING':
            continue
        place_id = pid_for(anch['place'])
        stay_id = f'stay-{len(lodgings) + 1}'
        policy_ev = mk_evidence(f'ev-policy-{stay_id}', stay_id,
                                'ROOM_POLICY', '入住15:00后 / 退房11:00前（候选声明）',
                                source_type='SYNTHETIC' if synthetic_world else 'USER',
                                source_uri='blueprint', retrieved_at=now, tz=tz,
                                valid_from=f'{anch["check_in"]}T15:00:00+08:00',
                                valid_until=f'{anch["check_out"]}T11:00:00+08:00',
                                date_specific=True,
                                status='VERIFIED' if synthetic_world else 'UNCONFIRMED')
        add_evid(policy_ev)
        booking_status = anch.get('booking_status', 'USER_REPORTED')
        booking_ev = None
        if booking_status == 'CONFIRMED':
            booking_ev = mk_evidence(f'ev-book-{stay_id}', stay_id, 'BOOKING',
                                     '供应商确认：已预订（合成世界供应商）',
                                     source_type='SYNTHETIC' if synthetic_world else 'AUTHORIZED_PLATFORM',
                                     source_uri=anch.get('booking_ref', 'blueprint#supplier'),
                                     retrieved_at=now, tz=tz,
                                     valid_from=f'{anch["check_in"]}T15:00:00+08:00',
                                     valid_until=f'{anch["check_out"]}T11:00:00+08:00',
                                     date_specific=True, status='VERIFIED')
            add_evid(booking_ev)
        lodgings.append({
            'id': stay_id, 'place_id': place_id,
            'check_in_date': anch['check_in'], 'check_out_date': anch['check_out'],
            'rooms': anch.get('rooms', 1), 'capacity_per_room': anch.get('capacity_per_room', 2),
            'policy_evidence_id': policy_ev['id'],
            'booking_status': booking_status,
            'booking_evidence_id': booking_ev['id'] if booking_ev else None,
            'locked': True,
            'rationale': anch.get('rationale', '用户已订，锁定不动。')})

    # 2) 每日装配
    for di, day_date in enumerate(dates):
        slots: list[dict] = []
        for anch in blueprint.get('anchors', []):
            if anch.get('day_index') != di or anch['kind'] == 'LODGING':
                continue
            place_id = pid_for(anch['place'])
            sid = f'd{di + 1}-{anch.get("slot_key", anch["kind"].lower())}'
            res_status = anch.get('reservation_status', 'NOT_REQUIRED')
            open_ev = opening_evidence(sid, place_id, anch, day_date) \
                if anch['kind'] in ('ATTRACTION', 'MEAL') else None
            res_ev = reservation_evidence(sid, place_id, res_status, day_date, True) \
                if anch['kind'] in ('ATTRACTION', 'MEAL') else None
            booking_ev = None
            if res_status == 'CONFIRMED' and anch['kind'] in ('ATTRACTION', 'MEAL'):
                booking_ev = mk_evidence(f'ev-book-{sid}', sid, 'BOOKING',
                                         '供应商确认：已预约（合成世界供应商）',
                                         source_type='SYNTHETIC' if synthetic_world
                                         else 'AUTHORIZED_PLATFORM',
                                         source_uri=anch.get('booking_ref', 'blueprint#supplier'),
                                         retrieved_at=now, tz=tz,
                                         valid_from=anch['start'], valid_until=anch['end'],
                                         date_specific=True, status='VERIFIED')
                add_evid(booking_ev)
            slots.append(_slot(
                sid, place_id, anch['kind'], anch['start'], anch['end'],
                locked=anch.get('locked', True),
                priority='MUST', availability=anch.get('availability', 'OPEN'),
                open_from=anch.get('open_from'), open_until=anch.get('open_until'),
                opening_evidence_id=open_ev, reservation_status=res_status,
                booking_evidence_id=booking_ev['id'] if booking_ev else None,
                reservation_evidence_id=res_ev,
                indoor_walk_m=anch.get('indoor_walk_m'),
                rationale=anch.get('rationale', '固定项（已订或边界）。'),
                highlight=anch.get('highlight', '')))
            used_candidates.add(anch['place']['name'])
        slots.sort(key=lambda s: s['start'])

        active = [st for st in lodgings if st['check_in_date'] <= day_date < st['check_out_date']]

        # 晨起/夜宿覆盖判定：晨起含退房日（≤check_out），夜宿不含（<check_out）
        stay_morning = [st for st in lodgings
                        if st['check_in_date'] <= day_date <= st['check_out_date']]
        stay_night = [st for st in lodgings
                      if st['check_in_date'] <= day_date < st['check_out_date']]

        # 填充：正餐按窗口、景点按优先级；全部避让固定项
        area = blueprint.get('areas', {}).get(str(di))
        day_end = _parse_hhmm(day_date, '21:30', tz)
        fixed_intervals = [(datetime.fromisoformat(s['start']).astimezone(tz),
                            datetime.fromisoformat(s['end']).astimezone(tz)) for s in slots]

        def _walk_between(name_a: str, name_b: str) -> int | None:
            hint = (hints.get(name_a) or {}).get(name_b) \
                or (hints.get(name_b) or {}).get(name_a)
            return hint.get('walk_m') if hint and hint.get('walk_m') is not None else None

        def _projected_day_walk(at: datetime, cur_slots: list[dict], cand: dict) -> int | None:
            """按时间位插入 cand 后的当日已知步行总量（含今晚回宿一腿）；未知 → None。"""
            ordered = sorted(cur_slots, key=lambda s: s['start'])
            names = [places[s['place_id']]['name'] for s in ordered]
            values = [s['indoor_walk_m'] for s in ordered]
            pair_walks = [_walk_between(n1, n2) for n1, n2 in zip(names, names[1:])]
            pos = next((i for i, s in enumerate(ordered)
                        if datetime.fromisoformat(s['start']).astimezone(tz) > at), len(ordered))
            values.extend(pair_walks)
            if pos > 0 and pos < len(ordered):   # 中间插入：prev→cand→next 取代 prev→next
                if values[len(ordered) + pos - 1] is None:
                    return None
                values[len(ordered) + pos - 1] = 0
            if pos > 0:
                values.append(_walk_between(names[pos - 1], cand['name']))
            values.append(cand.get('indoor_walk_m'))
            if pos < len(ordered):
                values.append(_walk_between(cand['name'], names[pos]))
            # 今晚回酒店的那一腿也计入（ OVERNIGHT_ANCHOR 不可隐去）
            if stay_night and di < len(dates) - 1:
                end_name = cand['name'] if pos == len(ordered) else names[-1]
                hotel_name = places[stay_night[0]['place_id']]['name']
                values.append(_walk_between(end_name, hotel_name))
            if any(v is None for v in values):
                return None
            return sum(values)

        def free(at_from: datetime, at_to: datetime) -> bool:
            return all(at_to <= f0 or at_from >= f1 for f0, f1 in fixed_intervals)

        def try_insert(cand: dict, want: datetime, dur_min: int) -> datetime | None:
            s = want
            if cand.get('open_from'):
                of = _parse_hhmm(day_date, cand['open_from'], tz)
                if s < of:
                    s = of
            e = s + timedelta(minutes=dur_min)
            if cand.get('open_until') and e > _parse_hhmm(day_date, cand['open_until'], tz):
                return None
            if e > day_end or not free(s, e):
                return None
            # 步行预算前置核算（已知量）：插入后超过每日上限就不排，换下一个候选
            if request.get('max_daily_walk_m') is not None:
                projected = _projected_day_walk(s, slots, cand)
                if projected is not None and projected > request['max_daily_walk_m']:
                    pending_notes.append(
                        f'候选「{cand["name"]}」未排入 {day_date}：已知步行量预测 '
                        f'{projected}m 超过每日上限 {request["max_daily_walk_m"]}m。'
                        f'放宽上限或替换其他地点后可重新排入。')
                    return None
            place_id = pid_for(cand)
            sid = f'd{di + 1}-{len(slots) + 1:02d}-{cand["kind"].lower()}'
            res_status = cand.get('reservation_status', 'NOT_REQUIRED')
            open_ev = opening_evidence(sid, place_id, cand, day_date) \
                if cand['kind'] in ('ATTRACTION', 'MEAL') else None
            res_ev = reservation_evidence(sid, place_id, res_status, day_date, False) \
                if cand['kind'] in ('ATTRACTION', 'MEAL') else None
            slots.append(_slot(
                sid, place_id, cand['kind'], _iso(s), _iso(e), locked=False,
                priority=cand.get('priority', 'PREFERRED'),
                availability='OPEN' if cand.get('open_from') else 'UNKNOWN',
                open_from=_iso(_parse_hhmm(day_date, cand['open_from'], tz)) if cand.get('open_from') else None,
                open_until=_iso(_parse_hhmm(day_date, cand['open_until'], tz)) if cand.get('open_until') else None,
                opening_evidence_id=open_ev, reservation_status=res_status,
                reservation_evidence_id=res_ev,
                indoor_walk_m=cand.get('indoor_walk_m'),
                rationale=cand.get('rationale', ''), highlight=cand.get('highlight', ''),
                fallback_slot_id=cand.get('fallback_slot_id')))
            fixed_intervals.append((s, e))
            used_candidates.add(cand['name'])
            return s

        meals_pool = [c for c in candidates if c['kind'] == 'MEAL' and c['name'] not in used_candidates]
        if area is not None:
            meals_pool.sort(key=lambda c: (c.get('area') != area, c.get('order', 99)))
        for w_start, _w_end in MEAL_WINDOWS:
            want = _parse_hhmm(day_date, w_start, tz)
            pick = next((mc for mc in meals_pool
                         if area is None or mc.get('area') == area), None)
            if pick is None:
                continue
            if try_insert(pick, want, pick.get('duration_min', 60)) is not None:
                meals_pool.remove(pick)

        pool = [c for c in candidates if c['kind'] == 'ATTRACTION'
                and c['name'] not in used_candidates
                and (area is None or c.get('area') == area)]
        pool.sort(key=lambda c: ({'MUST': 0, 'PREFERRED': 1, 'OPTIONAL': 2}[c.get('priority', 'PREFERRED')],
                                 c.get('order', 99)))
        for cand in pool:
            # 从当日最后活动后接续；开场受 open_from 约束
            last_end = max((datetime.fromisoformat(s['end']).astimezone(tz) for s in slots),
                           default=_parse_hhmm(day_date, '09:00', tz))
            if try_insert(cand, last_end + timedelta(minutes=30),
                          cand.get('duration_min', 90)) is None:
                continue   # 塞不进当日：诚实留空，不硬挤

        # 夜宿与晨起锚点（OVERNIGHT_ANCHOR 硬约束）：晚间回住宿，次日（含退房日早晨）
        # 从住宿出发。stay_morning/stay_night 已在填充前算好。
        if stay_morning:
            if slots and slots[0]['place_id'] != stay_morning[0]['place_id']:
                first_start = datetime.fromisoformat(slots[0]['start']).astimezone(tz)
                depart = max(_parse_hhmm(day_date, '07:30', tz),
                             first_start - timedelta(minutes=60))
                slots.insert(0, _slot(f'd{di + 1}-depart-hotel', stay_morning[0]['place_id'],
                                      'ARRIVAL', _iso(depart), _iso(depart + timedelta(minutes=10)),
                                      locked=True, priority='MUST',
                                      rationale='从住宿出发锚点（不隐去往返回路段）。',
                                      indoor_walk_m=0))
        if stay_night and di < len(dates) - 1:
            last_end = max(datetime.fromisoformat(s['end']).astimezone(tz) for s in slots)
            rest_start = min(max(last_end + timedelta(minutes=15),
                                 _parse_hhmm(day_date, '20:30', tz)), day_end)
            slots.append(_slot(f'd{di + 1}-rest', stay_night[0]['place_id'], 'REST',
                               _iso(rest_start), _iso(rest_start + timedelta(minutes=15)),
                               locked=True, priority='MUST', rationale='夜间回住宿锚点。',
                               indoor_walk_m=0))
        slots.sort(key=lambda s: s['start'])
        days.append({'date': day_date, 'slots': slots, 'daily_walk_m': None})

    # 3) legs：同日相邻、换地点才建段；修复循环内按最终邻接重建
    def build_legs() -> list[dict]:
        legs: list[dict] = []
        for day in days:
            for a, b in zip(day['slots'], day['slots'][1:]):
                if a['place_id'] == b['place_id']:
                    continue
                pa, pb = places[a['place_id']], places[b['place_id']]
                legs.append(_route_for(provider, a, b, pa, pb, request,
                                       add_evid, day['date'], hints, synthetic_world))
        return legs

    plan_legs: list[dict] = build_legs()

    # 4) 预算
    budget_items: list[dict] = []
    for b in blueprint.get('budget_items', []):
        budget_items.append({
            'id': b['id'], 'category': b['category'], 'subject_ids': b.get('subject_ids', []),
            'unit': b['unit'], 'unit_low_fen': b['unit_low_fen'], 'unit_high_fen': b['unit_high_fen'],
            'quantity': b['quantity'],
            'amount_low_fen': b['unit_low_fen'] * b['quantity'],
            'amount_high_fen': b['unit_high_fen'] * b['quantity'],
            'evidence_ids': [], 'status': b.get('status', 'ESTIMATE'),
            'notes': b.get('notes', '')})
    # 未排入的景点候选登记为备选（不进主行程预算与日程总量）
    alternatives: list[dict] = []
    for cand in candidates:
        if cand['kind'] != 'ATTRACTION' or cand['name'] in used_candidates:
            continue
        place_id = pid_for(cand)
        sid = f'alt-{cand["name"]}'
        open_ev = opening_evidence(sid, place_id, cand, dates[0]) if cand.get('open_from') else None
        alternatives.append({
            'id': sid, 'place_id': place_id, 'kind': 'ATTRACTION',
            'start': f'{dates[0]}T00:00:00+08:00', 'end': f'{dates[0]}T00:00:00+08:00',
            'locked': False, 'priority': 'OPTIONAL',
            'availability': 'OPEN' if cand.get('open_from') else 'UNKNOWN',
            'open_from': _iso(_parse_hhmm(dates[0], cand['open_from'], tz)) if cand.get('open_from') else None,
            'open_until': _iso(_parse_hhmm(dates[0], cand['open_until'], tz)) if cand.get('open_until') else None,
            'opening_evidence_id': open_ev, 'reservation_status': 'NOT_REQUIRED',
            'booking_evidence_id': None, 'reservation_evidence_id': None,
            'indoor_walk_m': cand.get('indoor_walk_m'),
            'rationale': cand.get('rationale', ''), 'highlight': cand.get('highlight', ''),
            'fallback_slot_id': None})

    plan = {
        'schema_version': SCHEMA_VERSION, 'trip_id': request['trip_id'], 'version': 1,
        'data_origin': blueprint.get('data_origin', 'SYNTHETIC'),
        'planning_status': 'DRAFT', 'theme': blueprint.get('theme', ''),
        'request': request, 'places': list(places.values()), 'evidence': [],
        'days': days, 'alternatives': alternatives, 'legs': plan_legs, 'lodgings': lodgings,
        'budget': {'currency': 'CNY', 'items': budget_items,
                   'total_low_fen': sum(i['amount_low_fen'] for i in budget_items),
                   'total_high_fen': sum(i['amount_high_fen'] for i in budget_items),
                   'excluded_categories': []},
        'pending_actions': list(pending_notes), 'change_summary': ''}

    # 5) 检查 + ≤2 轮确定性修复（只挪非锁定活动开始时间；每轮按最终邻接重建 legs）
    def refresh() -> dict:
        plan['evidence'] = list(evid_by_id.values())
        _recompute_walk(plan)
        return validate_plan_report(plan, now)

    def drop_closed_unlocked() -> int:
        """已知闭馆的非锁定活动不能留在主计划：移除并登记待确认（备选不自动顶替）。"""
        removed = 0
        for day in plan['days']:
            keep = []
            for s in day['slots']:
                if s['availability'] == 'CLOSED' and not s['locked']:
                    removed += 1
                    place_name = places.get(s['place_id'], {}).get('name', s['place_id'])
                    pending_notes.append(
                        f'「{place_name}」目标日闭馆，已移出 {day["date"]} 主计划；'
                        f'请从备选中重选或调整日期（激活备选前须重新核验）。')
                    continue
                keep.append(s)
            day['slots'] = keep
        return removed

    report = refresh()
    for round_no in range(TaskBudget.MAX_FIX_ROUNDS + 1):
        if budget is not None:
            budget.charge_fix_round()   # 修复轮计入任务时限（设计第 11 章），超时诚实停止
        if 'CLOSED' in issue_codes(report):
            drop_closed_unlocked()
            plan['legs'] = build_legs()
            report = refresh()
        if not (issue_codes(report) & {'TRANSFER_GAP', 'OVERLAP', 'OUTSIDE_OPENING'}):
            break
        if round_no == TaskBudget.MAX_FIX_ROUNDS:
            break   # 修复不动：诚实保留阻断，按当前邻接的 legs 交付
        _shift_fix(plan, report, tz)
        plan['legs'] = build_legs()   # 邻接可能变化，按最终顺序重建
        report = refresh()
    plan['pending_actions'] = list(dict.fromkeys(plan['pending_actions'] + pending_notes))
    plan['evidence'] = list(evid_by_id.values())
    meta = {'budget_snapshot': budget.snapshot() if budget else None,
            'fix_rounds_used': round_no}
    return plan, report, meta


def _route_for(provider, a: dict, b: dict, pa: dict, pb: dict, request: dict,
               add_evid, day_date: str, hints: dict, synthetic_world: bool) -> dict:
    """两地点间交通：真实坐标走 provider；否则用保守 hint；无依据如实标未知。"""
    leg_id = f'leg-{a["id"]}--{b["id"]}'
    if pa.get('coordinate_system') == 'GCJ02' and pb.get('coordinate_system') == 'GCJ02':
        result = provider.call('ROUTE', {
            'origin': f'{pa["lng"]},{pa["lat"]}', 'destination': f'{pb["lng"]},{pb["lat"]}',
            'mode': 'transit', 'city': request['destination'], 'date': day_date})
        data = result.get('data') or {}
        transits = (data.get('route') or {}).get('transits') or []
        if result['status'] == 'OK' and transits:
            dur = int(transits[0].get('duration') or 0)
            walking = sum(int(seg.get('walking', {}).get('distance', 0) or 0)
                          for seg in transits[0].get('segments', []) if isinstance(seg, dict))
            ev = mk_evidence(f'ev-{leg_id}', leg_id, 'ROUTE',
                             f'高德实时路线 {pa["name"]}→{pb["name"]} 估时{dur}s',
                             source_type='MAP_PROVIDER', source_uri=result['request_id'],
                             retrieved_at=result['retrieved_at'], tz=ZoneInfo(request['timezone']),
                             valid_from=result['retrieved_at'], valid_until=result['retrieved_at'],
                             date_specific=True, status='VERIFIED')
            add_evid(ev)
            return _mk_leg(leg_id, a, b, 'TRANSIT', max(1, int(dur * 0.9 / 60)),
                           int(dur * 1.3 / 60) + 5, 10, walking or None, ev['id'],
                           'PROVIDER_QUERY')
    hint = (hints.get(pa['name']) or {}).get(pb['name']) \
        or (hints.get(pb['name']) or {}).get(pa['name'])
    if hint:
        lo, hi = hint['transit_min_low'], hint['transit_min_high']
        ev = mk_evidence(f'ev-{leg_id}', leg_id, 'ROUTE',
                         f'候选保守估计 {pa["name"]}→{pb["name"]} {lo}–{hi}分钟',
                         source_type='SYNTHETIC' if synthetic_world else 'USER',
                         source_uri='blueprint#hints', retrieved_at=now_iso(),
                         tz=ZoneInfo(request['timezone']),
                         valid_from=f'{day_date}T00:00:00+08:00',
                         valid_until=f'{day_date}T23:59:59+08:00', date_specific=True,
                         status='VERIFIED' if synthetic_world else 'ESTIMATED')
        add_evid(ev)
        return _mk_leg(leg_id, a, b, hint.get('mode', 'TRANSIT'), lo, hi, 10,
                       hint.get('walk_m'), ev['id'], 'USER_SUPPLIED_CONSERVATIVE')
    ev = mk_evidence(f'ev-{leg_id}', leg_id, 'ROUTE',
                     f'无路线依据，占位待核查 {pa["name"]}→{pb["name"]}',
                     source_type='USER', source_uri='none', retrieved_at=now_iso(),
                     tz=ZoneInfo(request['timezone']),
                     valid_from=f'{day_date}T00:00:00+08:00',
                     valid_until=f'{day_date}T23:59:59+08:00', date_specific=True,
                     status='UNCONFIRMED')
    add_evid(ev)
    return _mk_leg(leg_id, a, b, 'TRANSIT', 1, 240, 30, None, ev['id'],
                   'UNKNOWN_UNTIL_CHECKED')


def _recompute_walk(plan: dict) -> None:
    legs = {l['id']: l for l in plan['legs']}
    for day in plan['days']:
        values = [s['indoor_walk_m'] for s in day['slots']]
        for a, b in zip(day['slots'], day['slots'][1:]):
            leg = next((l for l in legs.values()
                        if l['from_slot_id'] == a['id'] and l['to_slot_id'] == b['id']), None)
            if leg:
                values.append(leg['walk_m'])
        day['daily_walk_m'] = sum(v for v in values if v is not None) \
            if all(v is not None for v in values) else None


def _shift_fix(plan: dict, report: dict, tz: ZoneInfo) -> None:
    """确定性修复：把 TRANSFER_GAP/OUTSIDE_OPENING 的非锁定活动向后挪到可满足位置。"""
    slotmap = {s['id']: s for d in plan['days'] for s in d['slots']}
    legmap = {l['id']: l for l in plan['legs']}
    for issue in report['issues']:
        if issue['severity'] != 'BLOCK':
            continue
        if issue['code'] == 'TRANSFER_GAP':
            leg = legmap.get(issue['path'])
            if not leg or leg['to_slot_id'] not in slotmap:
                continue
            target = slotmap[leg['to_slot_id']]
            if target['locked']:
                continue
            need = leg['duration_high_min'] + leg['buffer_min']
            new_start = (datetime.fromisoformat(slotmap[leg['from_slot_id']]['end'])
                         + timedelta(minutes=need))
            dur = datetime.fromisoformat(target['end']) - datetime.fromisoformat(target['start'])
            target['start'] = _iso(new_start)
            target['end'] = _iso(new_start + dur)
        elif issue['code'] == 'OUTSIDE_OPENING':
            slot = slotmap.get(issue['path'])
            if not slot or slot['locked'] or not slot['open_from']:
                continue
            dur = datetime.fromisoformat(slot['end']) - datetime.fromisoformat(slot['start'])
            slot['start'] = slot['open_from']
            slot['end'] = _iso(datetime.fromisoformat(slot['open_from']) + dur)
    for day in plan['days']:
        day['slots'].sort(key=lambda s: s['start'])


# ---------- AUDIT：体检 = 校验 + 分域摘要，原计划原样保留 ----------
AUDIT_SECTIONS = {
    'SLOT_TIME': '时间', 'OVERLAP': '时间', 'OUTSIDE_OPENING': '时间', 'LOCAL_DATE': '时间',
    'TRANSFER_GAP': '路线', 'MISSING_LEG': '路线', 'LEG_RANGE': '路线', 'ORPHAN_LEG': '路线',
    'DUPLICATE_LEG': '路线',
    'OVER_BUDGET': '费用', 'BUDGET_TOTAL': '费用', 'COST_MULTIPLY': '费用',
    'COST_RANGE': '费用', 'ROOM_NIGHT_COST': '费用', 'BUDGET_COVERAGE': '费用', 'BUDGET_SCOPE': '费用',
    'RESERVATION_PENDING': '预约', 'SOLD_OUT': '预约', 'BOOKING_OVERCLAIM': '预约',
    'CLOSED': '预约', 'UNUSABLE_FALLBACK': '预约',
    'NIGHT_COVERAGE': '住宿', 'ROOM_CAPACITY': '住宿', 'LODGING_DATES': '住宿',
    'LODGING_PLACE': '住宿', 'OVERNIGHT_ANCHOR': '住宿', 'LODGING_PENDING': '住宿',
    'DAILY_WALK_LIMIT': '体力', 'SEGMENT_WALK_LIMIT': '体力', 'WALK_UNKNOWN': '体力',
    'WALK_TOTAL': '体力', 'WALK_FALSE_PRECISION': '体力',
}


def audit(plan: dict, now: str | None = None) -> dict:
    """体检：不修改原计划；输出报告 + 分域摘要 + 修订方向提示。"""
    now = now or now_iso()
    report = validate_plan_report(plan, now)
    sections: dict[str, list] = {}
    for issue in report['issues']:
        sections.setdefault(AUDIT_SECTIONS.get(issue['code'], '其他'), []).append(issue)
    return {'schema_version': SCHEMA_VERSION, 'trip_id': plan['trip_id'],
            'audited_version': plan['version'], 'checked_at': now,
            'decision': report['decision'], 'totals': report['totals'],
            'issues': report['issues'], 'sections': sections,
            'limitations': report['limitations'],
            'note': '原计划未被修改；修订须走 REPLAN 并生成新版本。'}


# ---------- REPLAN：局部改程 = 校验授权范围 + 应用编辑 + 全量检查 + 差异 ----------
def apply_change(old: dict, change: dict, edits: dict, *,
                 store=None, now: str | None = None) -> dict:
    """edits: {'slots': [完整 slot 对象...], 'lodgings': [...]}，只允许改 scope 内对象。
    返回 {'new'|'error', 'change_check', 'report', 'diff'}；错误时不含 new。
    授权/范围校验（validate_change）必须在 edits 应用之后执行：对比的是改后 plan，
    锁定项的任何改动都要求 user_approved 且 id∈allow_locked_ids，否则整体拒绝。
    邻接地点对变化的活动边会被重建为"待核查"占位（无路线依据时不猜数值），
    计划因此转 CONDITIONAL——激活备选/换点必须重新核验预约、交通与费用。
    """
    now = now or now_iso()
    new = copy.deepcopy(old)
    new['version'] = old['version'] + 1
    new['change_summary'] = change.get('reason', '')

    def apply_list(target_key: str, incoming: list[dict], scope: list[str]) -> None:
        outside = [e.get('id') for e in incoming if e.get('id') not in scope]
        if outside:
            raise ValueError(f'编辑超出批准范围：{outside}')
        if target_key == 'lodgings':
            containers = [new['lodgings']]
        else:
            containers = [d['slots'] for d in new['days']]   # 原位替换，不能复制列表
        index = {e['id']: (c, i) for c in containers for i, e in enumerate(c)}
        for e in incoming:
            if e['id'] not in index:
                raise ValueError(f'编辑对象不存在：{e["id"]}')
            container, i = index[e['id']]
            container[i] = e

    change_check: list[dict] = []
    try:
        # scope 缺省按空处理（fail-closed）；change 本身的形状由 validate_change 的
        # CHANGE_SCHEMA 检查兜底
        apply_list('slots', edits.get('slots', []), change.get('scope_slot_ids') or [])
        apply_list('lodgings', edits.get('lodgings', []), change.get('scope_lodging_ids') or [])
    except ValueError as exc:
        return {'error': str(exc), 'change_check': change_check}
    for day in new['days']:
        day['slots'].sort(key=lambda s: s['start'])
    change_check = validate_change_report(old, new, change)
    if change_check:
        return {'error': 'CHANGE_REJECTED', 'change_check': change_check}
    rebuilt = _rebuild_changed_legs(old, new, now)
    if rebuilt:
        new['change_summary'] = (new['change_summary'] +
                                 f'（{len(rebuilt)} 条邻接交通已重置为待核查，需临近重新核验）').strip()
    _recompute_walk(new)
    report = validate_plan_report(new, now)
    out: dict[str, Any] = {'new': new, 'change_check': change_check,
                           'report': report, 'diff': diff_plans(old, new),
                           'legs_reset': rebuilt}
    if store is not None:
        if report['decision'] == 'BLOCKED':
            out['commit'] = 'WITHHELD_BLOCKED_ISSUES'
        else:
            committed = store.commit_new_version(new, request_id=change['request_id'],
                                                 note=change.get('reason', ''))
            out['committed'] = {'version': committed['version'], 'status': committed['status'],
                                'idempotent': committed['idempotent']}
    return out


def _rebuild_changed_legs(old: dict, new: dict, now: str) -> list[str]:
    """地点对发生变化的邻接边：重建为无依据占位（UNCONFIRMED），并移除失配旧证据绑定。"""
    synthetic_world = old.get('data_origin') == 'SYNTHETIC'
    old_pairs = {}
    for day_o, day_n in zip(old['days'], new['days']):
        for a, b in zip(day_o['slots'], day_o['slots'][1:]):
            old_pairs[(a['id'], b['id'])] = (a['place_id'], b['place_id'])
    places = {p['id']: p for p in new['places']}
    evid_by_id = {e['id']: e for e in new['evidence']}
    rebuilt: list[str] = []
    tz = ZoneInfo(new['request']['timezone'])
    for day in new['days']:
        for a, b in zip(day['slots'], day['slots'][1:]):
            pair_changed = old_pairs.get((a['id'], b['id'])) != (a['place_id'], b['place_id'])
            if not pair_changed and a['place_id'] != b['place_id']:
                continue
            leg = next((l for l in new['legs']
                        if l['from_slot_id'] == a['id'] and l['to_slot_id'] == b['id']), None)
            if a['place_id'] == b['place_id']:
                if leg:
                    new['legs'].remove(leg)
                continue
            leg_id = leg['id'] if leg else f'leg-{a["id"]}--{b["id"]}'
            if not leg:
                leg = _mk_leg(leg_id, a, b, 'TRANSIT', 1, 240, 30, None, '', '')
                new['legs'].append(leg)
            ev_id = f'ev-{leg_id}'
            evid_by_id[ev_id] = mk_evidence(
                ev_id, leg_id, 'ROUTE',
                f'改程后邻接变化，占位待核查 {places[a["place_id"]]["name"]}→{places[b["place_id"]]["name"]}',
                source_type='USER', source_uri=f'replan#v{new["version"]}',
                retrieved_at=now, tz=tz,
                valid_from=f'{day["date"]}T00:00:00+08:00',
                valid_until=f'{day["date"]}T23:59:59+08:00', date_specific=True,
                status='UNCONFIRMED')
            leg['evidence_id'] = ev_id
            leg['estimate_basis'] = 'UNKNOWN_UNTIL_CHECKED'
            leg['duration_low_min'], leg['duration_high_min'], leg['buffer_min'] = 1, 240, 30
            leg['walk_m'] = None
            rebuilt.append(leg_id)
            # 旧的同名证据（若来自旧路线）被同 id 覆盖：保留审计可从 diff 看出
    new['evidence'] = list(evid_by_id.values())
    return rebuilt


def diff_plans(old: dict, new: dict) -> dict:
    """差异摘要：改了什么、没改什么、费用与时间变化、仍待确认什么。"""
    old_slots = {s['id']: s for d in old['days'] for s in d['slots']}
    new_slots = {s['id']: s for d in new['days'] for s in d['slots']}
    changed, kept = [], []
    for sid in sorted(set(old_slots) | set(new_slots)):
        if old_slots.get(sid) != new_slots.get(sid):
            changed.append(sid)
        elif sid in old_slots:
            kept.append(sid)
    old_legs = {l['id']: l for l in old['legs']}
    new_legs = {l['id']: l for l in new['legs']}
    # 同 ID 但内容被重置（如改程后邻接交通转为"待核查"）也算变更
    changed_leg_ids = sorted(set(old_legs) ^ set(new_legs)
                             | {lid for lid in old_legs.keys() & new_legs.keys()
                                if old_legs[lid] != new_legs[lid]})
    return {
        'changed_slot_ids': changed,
        'unchanged_slot_ids': kept,
        'changed_leg_ids': changed_leg_ids,
        'budget_delta_fen': {'low': new['budget']['total_low_fen'] - old['budget']['total_low_fen'],
                             'high': new['budget']['total_high_fen'] - old['budget']['total_high_fen']},
        'version': {'from': old['version'], 'to': new['version']},
        'locked_touched': [sid for sid in changed if old_slots.get(sid, {}).get('locked')
                           or new_slots.get(sid, {}).get('locked')],
    }
