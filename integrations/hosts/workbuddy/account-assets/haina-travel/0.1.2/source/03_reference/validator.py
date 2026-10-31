"""Offline reference checks, NOT a production trip planner or source verifier.
Usage: python 03_reference/validator.py 04_samples/base.json --now 2026-09-18T12:00:00+08:00
Exit codes: 0 checked planning; 2 conditional; 3 blocked. Never books or performs network I/O.
"""
from __future__ import annotations
import argparse
import json
from collections import Counter
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://schemas.example.invalid/haina-travel/0.1.0/'
SCHEMAS = {p.stem.replace('.schema',''): json.loads(p.read_text()) for p in (ROOT/'02_contracts').glob('*.json')}
REGISTRY = Registry().with_resources((s['$id'], Resource.from_contents(s)) for s in SCHEMAS.values())

def dt(value: str) -> datetime:
    out = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if out.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    return out

def schema_errors(name: str, data: Any) -> list[str]:
    validator = Draft202012Validator(SCHEMAS[name], registry=REGISTRY, format_checker=FormatChecker())
    return [f"/{'/'.join(map(str,e.absolute_path))}: {e.message}" for e in validator.iter_errors(data)]

def validate_plan(plan: dict[str, Any], now: str) -> dict[str, Any]:
    at = dt(now)
    issues: list[dict[str,str]] = []
    def add(code: str, severity: str, path: str, message: str) -> None:
        issues.append(dict(code=code,severity=severity,path=path,message=message))
    def result(low: int=0, high: int=0) -> dict[str, Any]:
        severity = {x['severity'] for x in issues}
        decision = 'BLOCKED' if 'BLOCK' in severity else 'CONDITIONAL' if 'NEEDS_CONFIRMATION' in severity else 'CHECKED_PLANNING'
        return dict(schema_version='0.1.0',trip_id=plan.get('trip_id','unknown'),plan_version=plan.get('version',1),checked_at=now,
                    scope='OFFLINE_SYNTHETIC' if plan.get('data_origin')=='SYNTHETIC' else 'SUPPLIED_DATA_ONLY',
                    decision=decision,issues=issues,totals=dict(computed_low_fen=low,computed_high_fen=high),
                    limitations=['仅检查输入数据的一致性；不证明原始来源真实、语义正确或未来仍有效。',
                                 '未执行联网、WorkBuddy联调、商家核验、真实路线测量、付款或预订。',
                                 '连续步行仅做单段超限检查；完整连续负荷、餐食禁忌、天气安全与替代路线仍需生产实现及人工复核。'])
    errors = schema_errors('itinerary', plan)
    if errors:
        for error in errors: add('SCHEMA','BLOCK','/',error)
        return result()
    req=plan['request']; tz=ZoneInfo(req['timezone'])
    if req['trip_id']!=plan['trip_id']: add('TRIP_ID','BLOCK','/request/trip_id','请求与计划属于不同旅行。')
    start=date.fromisoformat(req['start_date']); end=date.fromisoformat(req['end_date'])
    if not 2 <= (end-start).days+1 <= 7:
        add('DATE_RANGE','BLOCK','/request','首版仅接受2—7天；结束不得早于开始。')
        return result()
    expected_days=[(start+timedelta(days=i)).isoformat() for i in range(max(0,(end-start).days+1))]
    if [d['date'] for d in plan['days']]!=expected_days: add('DAY_COVERAGE','BLOCK','/days','每日安排必须按日期连续覆盖整个行程。')
    evid={e['id']:e for e in plan['evidence']}; places={p['id']:p for p in plan['places']}
    slots=[s for d in plan['days'] for s in d['slots']]
    slotmap={s['id']:s for s in slots}; alts={s['id']:s for s in plan['alternatives']}
    groups=[plan['evidence'],plan['places'],slots,plan['alternatives'],plan['legs'],plan['lodgings'],plan['budget']['items']]
    all_ids=[v['id'] for g in groups for v in g]
    if len(all_ids)!=len(set(all_ids)): add('DUPLICATE_ID','BLOCK','/','对象ID必须全局唯一。')
    for e in plan['evidence']:
        if dt(e['valid_until'])<dt(e['valid_from']) or dt(e['expires_at'])<dt(e['retrieved_at']):
            add('EVIDENCE_TIME','BLOCK',e['id'],'证据时间范围非法。')
        if dt(e['retrieved_at'])>at: add('FUTURE_RETRIEVAL','BLOCK',e['id'],'不能声称在未来已完成查询。')
        if plan['data_origin']=='LIVE' and e['source_type']=='SYNTHETIC': add('SYNTHETIC_AS_LIVE','BLOCK',e['id'],'合成证据不能用于真实已核实结论。')
    def need(eid: str|None, subject: str, claim: str, a: str, b: str, date_specific: bool=False, supplier: bool=False) -> None:
        e=evid.get(eid or '')
        if not e:
            add('MISSING_EVIDENCE','NEEDS_CONFIRMATION',subject,f'缺少{claim}证据。'); return
        if e['subject_id']!=subject or e['claim_type']!=claim:
            add('EVIDENCE_BINDING','BLOCK',subject,'引用证据不属于这个对象或事实类型。'); return
        if e['status']!='VERIFIED' or dt(e['expires_at'])<=at:
            add('EVIDENCE_UNRESOLVED','NEEDS_CONFIRMATION',subject,'证据未核实、有冲突或已到复查期限。')
        if dt(e['valid_from'])>dt(a) or dt(e['valid_until'])<dt(b):
            add('EVIDENCE_COVERAGE','NEEDS_CONFIRMATION',subject,'证据不覆盖实际计划使用时段。')
        if date_specific and not e['date_specific']:
            add('DATE_NOT_SPECIFIC','NEEDS_CONFIRMATION',subject,'通用介绍不能充当目标日期已核实信息。')
        if supplier and e['source_type'] not in ('OFFICIAL','OPERATOR','AUTHORIZED_PLATFORM','SYNTHETIC'):
            add('BOOKING_OVERCLAIM','BLOCK',subject,'用户自述或地图记录不能证明供应商确认预订。')
    for day in plan['days']:
        ss=day['slots']; last=None
        for s in ss:
            a,b=dt(s['start']),dt(s['end'])
            if b<=a: add('SLOT_TIME','BLOCK',s['id'],'结束时间必须晚于开始时间。')
            if a.astimezone(tz).date().isoformat()!=day['date'] or b.astimezone(tz).date().isoformat()!=day['date']:
                add('LOCAL_DATE','BLOCK',s['id'],'时区或跨日错误；跨午夜活动须拆段。')
            if last and dt(last['end'])>a: add('OVERLAP','BLOCK',s['id'],'与上一个活动重叠。')
            last=s
            p=places.get(s['place_id'])
            if not p: add('MISSING_PLACE','BLOCK',s['id'],'地点ID不存在。'); continue
            need(p['identity_evidence_id'],p['id'],'IDENTITY',s['start'],s['end'])
            if set(p['tags']) & set(req['hard_exclusions']): add('EXCLUSION','BLOCK',s['id'],'违反用户明确排除标签。')
            if s['availability']=='CLOSED': add('CLOSED','BLOCK',s['id'],'不可安排已知关闭地点。')
            if s['kind'] in ('ATTRACTION','MEAL'):
                if s['availability']=='UNKNOWN': add('OPENING_UNKNOWN','NEEDS_CONFIRMATION',s['id'],'开放情况待核实。')
                need(s['opening_evidence_id'],p['id'],'OPENING',s['start'],s['end'],True)
                need(s['reservation_evidence_id'],p['id'],'RESERVATION',s['start'],s['end'],True)
                if s['open_from'] is None or s['open_until'] is None:
                    add('OPEN_INTERVAL_UNKNOWN','NEEDS_CONFIRMATION',s['id'],'缺少可用开放时间窗。')
                elif a<dt(s['open_from']) or b>dt(s['open_until']): add('OUTSIDE_OPENING','BLOCK',s['id'],'活动未完全落在开放时间窗内。')
            if s['reservation_status']=='CONFIRMED': need(s['booking_evidence_id'],s['id'],'BOOKING',s['start'],s['end'],True,True)
            elif s['reservation_status']=='SOLD_OUT': add('SOLD_OUT','BLOCK',s['id'],'已售罄项目不能作为主行程。')
            elif s['reservation_status']!='NOT_REQUIRED': add('RESERVATION_PENDING','NEEDS_CONFIRMATION',s['id'],'未取得可核对的预订确认。')
            if s['fallback_slot_id'] and s['fallback_slot_id'] not in alts: add('MISSING_FALLBACK','BLOCK',s['id'],'备选ID不存在。')
            cap=req['max_continuous_walk_m']
            if cap is not None and s['indoor_walk_m'] is not None and s['indoor_walk_m']>cap:
                add('SEGMENT_WALK_LIMIT','BLOCK',s['id'],'单活动内部步行已超过连续步行上限。')
        links={(x['from_slot_id'],x['to_slot_id']):x for x in plan['legs']}
        walking=[s['indoor_walk_m'] for s in ss]
        for before,after in zip(ss,ss[1:]):
            leg=links.get((before['id'],after['id']))
            if before['place_id']!=after['place_id'] and not leg:
                add('MISSING_LEG','BLOCK',after['id'],'更换地点却没有交通段。'); continue
            if not leg: continue
            if leg['duration_low_min']>leg['duration_high_min']: add('LEG_RANGE','BLOCK',leg['id'],'交通时长区间倒置。')
            required=leg['duration_high_min']+leg['buffer_min']
            gap=(dt(after['start'])-dt(before['end'])).total_seconds()/60
            if gap<required: add('TRANSFER_GAP','BLOCK',leg['id'],f'仅留{gap:g}分钟，保守时长与缓冲共需{required}分钟。')
            need(leg['evidence_id'],leg['id'],'ROUTE',before['end'],after['start'])
            walking.append(leg['walk_m'])
            cap=req['max_continuous_walk_m']
            if cap is not None and leg['walk_m'] is not None and leg['walk_m']>cap:
                add('SEGMENT_WALK_LIMIT','BLOCK',leg['id'],'交通中的步行已超过单段上限。')
        if any(v is None for v in walking):
            if day['daily_walk_m'] is not None: add('WALK_FALSE_PRECISION','BLOCK',day['date'],'含未知步行时，不能输出精确日总量。')
            if req['max_daily_walk_m'] is not None: add('WALK_UNKNOWN','NEEDS_CONFIRMATION',day['date'],'尚不能确认是否满足步行上限。')
        else:
            total=sum(walking)
            if day['daily_walk_m']!=total: add('WALK_TOTAL','BLOCK',day['date'],'日步行合计不一致。')
            if req['max_daily_walk_m'] is not None and total>req['max_daily_walk_m']:
                add('DAILY_WALK_LIMIT','BLOCK',day['date'],'超过用户每日步行上限。')
    linkpairs=Counter((l['from_slot_id'],l['to_slot_id']) for l in plan['legs'])
    if any(n>1 for n in linkpairs.values()): add('DUPLICATE_LEG','BLOCK','/legs','同一主线衔接不能存在两条未选择的交通方案。')
    expectedpairs={(a['id'],b['id']) for d in plan['days'] for a,b in zip(d['slots'],d['slots'][1:])}
    for l in plan['legs']:
        if (l['from_slot_id'],l['to_slot_id']) not in expectedpairs: add('ORPHAN_LEG','BLOCK',l['id'],'交通段未绑定到同日相邻的主行程活动。')
    for alt in plan['alternatives']:
        if alt['place_id'] not in places: add('MISSING_PLACE','BLOCK',alt['id'],'备选地点不存在。')
        if alt['availability']=='CLOSED' or alt['reservation_status']=='SOLD_OUT': add('UNUSABLE_FALLBACK','WARN',alt['id'],'此备选不可用；不可声称已有可执行替代。')
    for stay in plan['lodgings']:
        if stay['place_id'] not in places or places[stay['place_id']]['category']!='HOTEL': add('LODGING_PLACE','BLOCK',stay['id'],'住宿必须对应一个酒店地点。')
        ci=date.fromisoformat(stay['check_in_date']); co=date.fromisoformat(stay['check_out_date'])
        if ci<start or co>end or co<=ci: add('LODGING_DATES','BLOCK',stay['id'],'入住退房日期非法或超出首版行程范围。')
        if stay['rooms']*stay['capacity_per_room']<req['party_size']: add('ROOM_CAPACITY','BLOCK',stay['id'],'房间容量不足以容纳同行人数。')
        a=ci.isoformat()+'T15:00:00+08:00'; b=co.isoformat()+'T11:00:00+08:00'
        need(stay['policy_evidence_id'],stay['id'],'ROOM_POLICY',a,b,True)
        if stay['booking_status']=='CONFIRMED': need(stay['booking_evidence_id'],stay['id'],'BOOKING',a,b,True,True)
        else: add('LODGING_PENDING','NEEDS_CONFIRMATION',stay['id'],'住宿尚未供应商确认；不得称为已订好。')
    for i in range(max(0,(end-start).days)):
        night=(start+timedelta(days=i)).isoformat()
        active=[s for s in plan['lodgings'] if s['check_in_date']<=night<s['check_out_date']]
        if len(active)!=1: add('NIGHT_COVERAGE','BLOCK',night,'每晚必须有且只有一个已选择住宿安排。')
        elif len(plan['days'])>i+1:
            prev=plan['days'][i]['slots'][-1]; nxt=plan['days'][i+1]['slots'][0]
            if prev['place_id']!=active[0]['place_id'] or nxt['place_id']!=active[0]['place_id']:
                add('OVERNIGHT_ANCHOR','BLOCK',night,'前一日应回到住宿，次日从住宿出发；不能隐去往返路段。')
    low=high=0; cats=set()
    for row in plan['budget']['items']:
        cats.add(row['category']); a=row['unit_low_fen']*row['quantity']; b=row['unit_high_fen']*row['quantity']
        low+=a; high+=b
        if row['unit_high_fen']<row['unit_low_fen']: add('COST_RANGE','BLOCK',row['id'],'费用区间倒置。')
        if row['amount_low_fen']!=a or row['amount_high_fen']!=b: add('COST_MULTIPLY','BLOCK',row['id'],'费用单价×数量与小计不符。')
        if row['status']=='QUOTE':
            if not row['evidence_ids']: add('QUOTE_EVIDENCE','NEEDS_CONFIRMATION',row['id'],'报价缺少可核对来源。')
            for eid in row['evidence_ids']:
                need(eid,row['id'],'PRICE',req['start_date']+'T00:00:00+08:00',req['end_date']+'T23:59:59+08:00',True)
    if (plan['budget']['total_low_fen'],plan['budget']['total_high_fen'])!=(low,high): add('BUDGET_TOTAL','BLOCK','/budget','预算总额与明细不一致。')
    if high>req['budget_cap_fen']: add('OVER_BUDGET','BLOCK','/budget','保守预算上界超出明确预算；应改方案或让用户修改预算。')
    required={'MEALS','LOCAL_TRANSPORT','TICKETS','RESERVE'} | ({'LODGING'} if end>start else set()) | ({'INTERCITY'} if req['budget_scope']=='ALL_IN' else set())
    if not required<=cats: add('BUDGET_COVERAGE','BLOCK','/budget','必要费用类别缺失；免费项目应以零费用明列。')
    if required & set(plan['budget']['excluded_categories']): add('BUDGET_SCOPE','BLOCK','/budget','不能一边声称全包，一边排除必须覆盖的费用。')
    expected_room_nights=sum(s['rooms']*(date.fromisoformat(s['check_out_date'])-date.fromisoformat(s['check_in_date'])).days for s in plan['lodgings'])
    room_nights=sum(r['quantity'] for r in plan['budget']['items'] if r['category']=='LODGING' and r['unit']=='ROOM_NIGHT')
    if room_nights!=expected_room_nights: add('ROOM_NIGHT_COST','BLOCK','/budget','住宿预算间夜数与入住安排不一致。')
    if plan['planning_status'] in ('CHECKED','ACCEPTED') and any(i['severity'] in ('BLOCK','NEEDS_CONFIRMATION') for i in issues):
        add('STATUS_OVERCLAIM','BLOCK','/planning_status','存在阻断或待确认项时不得标为CHECKED/ACCEPTED。')
    return result(low,high)

def validate_change(old: dict[str,Any], new: dict[str,Any], change: dict[str,Any]) -> list[dict[str,str]]:
    """Checks proposal authorization/scope only. Caller MUST also validate_plan(new).
    No persistence, idempotency store, semantic intent parser or booking mutation here.
    """
    out=[]
    def fail(code: str, message: str) -> None: out.append(dict(code=code,severity='BLOCK',path='/change',message=message))
    for name,data in [('itinerary',old),('itinerary',new),('change_request',change)]:
        if schema_errors(name,data): fail('CHANGE_SCHEMA','变更输入未通过Schema。'); return out
    if len({old['trip_id'],new['trip_id'],change['trip_id']})!=1: fail('CHANGE_TRIP','旅行ID不一致。')
    if old['version']!=change['expected_version'] or new['version']!=old['version']+1: fail('VERSION_CONFLICT','基线版本冲突，必须重新基于当前版本生成。')
    if old['data_origin']!=new['data_origin']: fail('ORIGIN_CHANGE','禁止通过变更转换数据真实性标签。')
    if old['request']!=new['request']: fail('REQUEST_CHANGE','参考改程只支持相同TripRequest；需求变更须走新请求确认与全量复核流程。')
    for collection,scope in [('slots','scope_slot_ids'),('lodgings','scope_lodging_ids')]:
        a=[s for d in old['days'] for s in d['slots']] if collection=='slots' else old['lodgings']
        b=[s for d in new['days'] for s in d['slots']] if collection=='slots' else new['lodgings']
        am={s['id']:s for s in a}; bm={s['id']:s for s in b}
        for key in am.keys() | bm.keys():
            if am.get(key)==bm.get(key): continue
            if key not in change[scope]: fail('OUTSIDE_CHANGE_SCOPE',f'{key}超出本次批准变更范围。')
            if key in am and am[key]['locked'] and not (change['user_approved'] and key in change['allow_locked_ids']): fail('LOCKED_CHANGE',f'{key}已锁定，缺少具体解锁授权。')
    return out

def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('plan',type=Path)
    parser.add_argument('--now',default=datetime.now().astimezone().isoformat())
    args=parser.parse_args()
    try:
        data=json.loads(args.plan.read_text()); report=validate_plan(data,args.now)
    except (OSError,ValueError,TypeError) as exc:
        print(json.dumps({'error':str(exc)},ensure_ascii=False)); return 3
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return {'CHECKED_PLANNING':0,'CONDITIONAL':2,'BLOCKED':3}[report['decision']]
if __name__=='__main__': raise SystemExit(main())
