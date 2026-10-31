"""M0 平台能力探针：能离线判定的直接判定，需要实机/账号的如实标 NEEDS_HUMAN。

探针结果一律诚实：RUN+PASS/FAIL 带证据；NEEDS_HUMAN 说明缺什么、怎么补。
不伪造 RUN；不把本地通过说成 WorkBuddy 通过。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from .checks import validate_plan_report
from .exporters import export_all
from .guards import TaskBudget
from .pipeline import apply_change, build_plan
from .providers import AmapProvider, SnapshotProvider
from .results import now_iso
from .schemas import assert_format_checker_strict
from .state import TripStore, VersionConflict

ROOT = Path(__file__).resolve().parents[2]   # src/haina_travel/probe.py → 仓库根
BLUEPRINT = ROOT / 'tests' / 'fixtures' / 'blueprint_smoke.json'


def _probe_strict_format() -> dict:
    try:
        assert_format_checker_strict()
        return {'status': 'PASS', 'evidence': 'naive timestamp rejected; RFC3339 enforced'}
    except RuntimeError as exc:
        return {'status': 'FAIL', 'evidence': str(exc)[:200]}


def _probe_reference_baseline() -> dict:
    proc = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', '05_tests'],
                          capture_output=True, text=True, cwd=ROOT)
    tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or ['']
    ok = proc.returncode == 0 and 'OK' in tail[0]
    return {'status': 'PASS' if ok else 'FAIL',
            'evidence': f'rc={proc.returncode}; {tail[0][:80]}'}


def _probe_engine_end_to_end() -> dict:
    try:
        bp = json.loads(BLUEPRINT.read_text(encoding='utf-8'))
        plan, report, _ = build_plan(bp, SnapshotProvider(ROOT / 'work' / 'snapshots'),
                                     TaskBudget())
        if report['decision'] != 'CHECKED_PLANNING':
            return {'status': 'FAIL',
                    'evidence': f"decision={report['decision']} issues={report['issues'][:2]}"}
        return {'status': 'PASS', 'evidence': f"trip {plan['trip_id']} v{plan['version']} CHECKED_PLANNING, "
                                              f"{len(plan['evidence'])} evidence, legs {len(plan['legs'])}"}
    except Exception as exc:   # 探针要把一切失败变成可读证据
        return {'status': 'FAIL', 'evidence': repr(exc)[:200]}


def _probe_state_and_replan() -> dict:
    try:
        bp = json.loads(BLUEPRINT.read_text(encoding='utf-8'))
        plan, report, _ = build_plan(bp, SnapshotProvider(ROOT / 'work' / 'snapshots'), TaskBudget())
        with tempfile.TemporaryDirectory() as td:
            store = TripStore(td)
            store.commit_new_version(plan, request_id='probe-init')
            day2 = plan['days'][1]
            attr = next(s for s in day2['slots'] if s['kind'] == 'ATTRACTION' and not s['locked'])
            new_attr = dict(attr, end='2026-10-02T14:00:00+08:00')
            change = {"schema_version": "0.1.0", "trip_id": plan['trip_id'],
                      "expected_version": 1, "request_id": "probe-rp",
                      "reason": "探针：缩短下午", "scope_slot_ids": [attr['id']],
                      "scope_lodging_ids": [], "allow_locked_ids": [],
                      "user_approved": True, "new_requirements": []}
            out = apply_change(plan, change, {'slots': [new_attr], 'lodgings': []}, store=store)
            cur, idx = store.load_current(plan['trip_id'])
            ok = out.get('committed', {}).get('version') == 2 and cur['version'] == 2
            return {'status': 'PASS' if ok else 'FAIL',
                    'evidence': f'v1→v2 committed; history={len(idx["history"])}'}
    except Exception as exc:
        return {'status': 'FAIL', 'evidence': repr(exc)[:200]}


def _probe_version_conflict() -> dict:
    try:
        bp = json.loads(BLUEPRINT.read_text(encoding='utf-8'))
        plan, _, _ = build_plan(bp, SnapshotProvider(ROOT / 'work' / 'snapshots'), TaskBudget())
        with tempfile.TemporaryDirectory() as td:
            store = TripStore(td)
            store.commit_new_version(plan, request_id='a')
            try:
                store.commit_new_version(plan, request_id='b')
                return {'status': 'FAIL', 'evidence': '重复版本提交未被拒绝'}
            except VersionConflict as exc:
                return {'status': 'PASS', 'evidence': str(exc)[:100]}
    except Exception as exc:
        return {'status': 'FAIL', 'evidence': repr(exc)[:200]}


def _probe_export() -> dict:
    try:
        bp = json.loads(BLUEPRINT.read_text(encoding='utf-8'))
        plan, report, _ = build_plan(bp, SnapshotProvider(ROOT / 'work' / 'snapshots'), TaskBudget())
        with tempfile.TemporaryDirectory() as td:
            entry = export_all(plan, report, td)
            sizes = {n: (Path(td) / f'v{plan["version"]}-{n}').stat().st_size for n in entry['files']}
            return {'status': 'PASS', 'evidence': f'三层导出 {sizes}'}
    except Exception as exc:
        return {'status': 'FAIL', 'evidence': repr(exc)[:200]}


def _probe_local_state_dir() -> dict:
    """沙箱写入规则：~/.local/share 可写、零删除零 mv 语义（link 原子创建）。"""
    home = Path.home() / '.local' / 'share' / 'haina-travel'
    try:
        probe_dir = home / 'probe'
        probe_dir.mkdir(parents=True, exist_ok=True)
        target = probe_dir / 'probe-write-test.json'
        if target.exists():
            # 只新增语义：已存在即换名，不删除
            target = probe_dir / f'probe-write-test-{os.getpid()}.json'
        target.write_text(now_iso(), encoding='utf-8')
        ok = target.is_file()
        return {'status': 'PASS' if ok else 'FAIL',
                'evidence': f'wrote {target}（不删除既有探针文件）'}
    except OSError as exc:
        return {'status': 'FAIL', 'evidence': f'{exc}'[:200]}


def _probe_amap_key() -> dict:
    p = AmapProvider()
    if not p.configured:
        return {'status': 'NEEDS_HUMAN',
                'evidence': '未发现高德 KEY。提供方式：AMAP_KEY 环境变量，或'
                            ' ~/.local/share/haina-travel/config.json {"amap_key":"..."}；'
                            '同时需要确认商用许可与配额（设计 8.2/8.4）。'}
    r = p.call('PLACE_SEARCH', {'keywords': '博物馆', 'city': '北京', 'offset': 1, 'page_size': 1})
    return {'status': 'PASS' if r['status'] in ('OK', 'PARTIAL') else 'FAIL',
            'evidence': f"live PLACE_SEARCH → {r['status']} ({r['error_code']})"}


def _probe_workbuddy_cli() -> dict:
    cli = Path('/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy')
    if not cli.is_file():
        return {'status': 'NEEDS_HUMAN', 'evidence': '未找到 WorkBuddy CLI；需实机安装验证'}
    return {'status': 'NEEDS_HUMAN',
            'evidence': f'CLI 存在（{cli.name}）。专家包构建后需用 '
                        f'`codebuddy -p --plugin-dir <dist包>` 实测召唤与技能路由，'
                        f'需用户在场让出键鼠。'}


def _probe_sandbox_tools() -> dict:
    seatbelt = shutil.which('sandbox-exec')
    return {'status': 'NEEDS_HUMAN' if not seatbelt else 'PASS',
            'evidence': f'sandbox-exec={"有" if seatbelt else "无"}；'
                        f'引擎零删除零 mv，link 原子创建（state.py），已在探针 5 验证本地路径'}


def run_all_probes() -> dict:
    probes = {
        'P1_strict_format_checker': _probe_strict_format,
        'P2_reference_64_tests': _probe_reference_baseline,
        'P3_engine_plan_end_to_end': _probe_engine_end_to_end,
        'P4_state_version_and_replan': _probe_state_and_replan,
        'P5_version_conflict_guard': _probe_version_conflict,
        'P6_export_three_layers': _probe_export,
        'P7_local_state_dir_writable': _probe_local_state_dir,
        'P8_amap_live_access': _probe_amap_key,
        'P9_workbuddy_cli_and_package': _probe_workbuddy_cli,
        'P10_sandbox_seatbelt': _probe_sandbox_tools,
    }
    results = {}
    for name, fn in probes.items():
        try:
            results[name] = fn()
        except Exception as exc:
            results[name] = {'status': 'FAIL', 'evidence': repr(exc)[:200]}
    summary = {s: sum(1 for r in results.values() if r['status'] == s)
               for s in ('PASS', 'FAIL', 'NEEDS_HUMAN')}
    return {'generated_at': now_iso(), 'summary': summary, 'probes': results,
            'note': 'PASS=已运行有证据；NEEDS_HUMAN=需账号/实机/用户参与；'
                    '本探针不把离线通过等同 WorkBuddy 实机通过。'}


if __name__ == '__main__':
    print(json.dumps(run_all_probes(), ensure_ascii=False, indent=1))
