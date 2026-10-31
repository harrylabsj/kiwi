"""命令行入口：模型/技能通过这些子命令调用引擎，输出 JSON（人可读）。

所有子命令都不联网（除 provider 显式 LIVE 调用）；失败返回非零码并给 JSON 错误。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .checks import validate_change_report, validate_plan_report
from .exporters import export_all
from .guards import TaskBudget
from .pipeline import apply_change, audit, build_plan
from .providers import AmapProvider, SnapshotProvider
from .results import now_iso
from .state import TripStore, VersionConflict


def _read(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding='utf-8'))


def _emit(data) -> int:
    print(json.dumps(data, ensure_ascii=False, indent=1))
    return 0


def cmd_validate(args) -> int:
    if args.change and not args.old:
        print(json.dumps({'error': '使用 --change 时必须同时提供 --old（变更基线版本文件）'},
                         ensure_ascii=False))
        return 2
    now = args.now or now_iso()
    plan = _read(args.plan)
    report = validate_plan_report(plan, now)
    if args.change:
        out = _emit({'plan_report': report,
                     'change_check': validate_change_report(_read(args.old), plan, _read(args.change))})
    else:
        out = _emit(report)
    return {'CHECKED_PLANNING': 0, 'CONDITIONAL': 2, 'BLOCKED': 3}[report['decision']]


def cmd_plan(args) -> int:
    bp = _read(args.blueprint)
    budget = TaskBudget()
    if args.provider == 'live':
        provider = AmapProvider(budget=budget, raw_dir=Path('work/raw'))
    else:
        provider = SnapshotProvider(Path(args.snapshot_dir), budget=budget)
    plan, report, meta = build_plan(bp, provider, budget, now=args.now)
    meta['budget_snapshot'] = budget.snapshot()
    return _emit({'plan': plan, 'report': report, 'meta': meta})


def cmd_audit(args) -> int:
    return _emit(audit(_read(args.plan), now=args.now))


def cmd_replan(args) -> int:
    old = _read(args.plan)
    change = _read(args.change)
    edits = _read(args.edits)
    store = TripStore() if not args.no_store else None
    out = apply_change(old, change, edits, store=store, now=args.now)
    _emit(out)
    return 1 if 'error' in out else (3 if out['report']['decision'] == 'BLOCKED' else 0)


def cmd_export(args) -> int:
    plan = _read(args.plan)
    report = validate_plan_report(plan, now=args.now)
    links = json.loads(Path(args.map_links).read_text(encoding='utf-8')) if args.map_links else None
    entry = export_all(plan, report, Path(args.out), map_links=links)
    return _emit(entry)


def cmd_state(args) -> int:
    store = TripStore()
    if args.op == 'show':
        cur, idx = store.load_current(args.trip_id)
        return _emit({'index': idx, 'plan_version': cur['version']})
    if args.op == 'versions':
        return _emit(store.list_versions(args.trip_id))
    if args.op == 'accept':
        idx = store.mark_accepted(args.trip_id, version=args.version, request_id=args.request_id)
        return _emit(idx)
    return 2


def cmd_probes(args) -> int:
    from .probe import run_all_probes
    return _emit(run_all_probes())


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog='haina-travel', description='海纳·旅行专家引擎')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('validate', help='校验行程（可选附带变更校验）')
    p.add_argument('plan')
    p.add_argument('--change')
    p.add_argument('--old', help='变更基线版本（配合 --change）')
    p.add_argument('--now')
    p.set_defaults(fn=cmd_validate)

    p = sub.add_parser('plan', help='blueprint → 装配行程')
    p.add_argument('blueprint')
    p.add_argument('--provider', choices=['snapshot', 'live'], default='snapshot')
    p.add_argument('--snapshot-dir', default='work/snapshots')
    p.add_argument('--now')
    p.set_defaults(fn=cmd_plan)

    p = sub.add_parser('audit', help='行程体检')
    p.add_argument('plan')
    p.add_argument('--now')
    p.set_defaults(fn=cmd_audit)

    p = sub.add_parser('replan', help='局部改程')
    p.add_argument('plan')
    p.add_argument('change')
    p.add_argument('edits')
    p.add_argument('--no-store', action='store_true')
    p.add_argument('--now')
    p.set_defaults(fn=cmd_replan)

    p = sub.add_parser('export', help='三层交付导出')
    p.add_argument('plan')
    p.add_argument('--out', required=True)
    p.add_argument('--map-links')
    p.add_argument('--now')
    p.set_defaults(fn=cmd_export)

    p = sub.add_parser('state', help='版本状态')
    p.add_argument('op', choices=['show', 'versions', 'accept'])
    p.add_argument('trip_id')
    p.add_argument('--version', type=int)
    p.add_argument('--request_id')
    p.set_defaults(fn=cmd_state)

    p = sub.add_parser('probes', help='M0 平台能力探针（可离线部分）')
    p.set_defaults(fn=cmd_probes)

    args = parser.parse_args(argv)
    try:
        return args.fn(args)
    except VersionConflict as exc:
        print(json.dumps({'error': 'VERSION_CONFLICT', 'message': str(exc)},
                         ensure_ascii=False))
        return 4
    except (ValueError, FileNotFoundError) as exc:
        print(json.dumps({'error': str(exc)[:300]}, ensure_ascii=False))
        return 2
    except (OSError, RuntimeError, KeyError, TypeError) as exc:
        # FileExistsError/BudgetExceeded/ProviderError 等同样以 JSON 报错，不裸崩
        print(json.dumps({'error': f'{type(exc).__name__}: {str(exc)[:280]}'},
                         ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
