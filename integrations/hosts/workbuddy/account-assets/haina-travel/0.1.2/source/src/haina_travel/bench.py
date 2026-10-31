"""M3 对照计量框架：冻结、72 条登记、评审表、留出集模板。

诚实边界（PROTOCOL 第 2/6 条）：
- 本模块只准备与登记；72 条正式运行必须由同条件模型会话产生，不能由本引擎
  离线执行替代。run_offline_smoke 仅供管道调试，标记 OFFLINE_ENGINE_SMOKE，
  不计入对照结论。
- 公开集（12 案例）通过后，留出集须由非实现者另制；模板只占位不预设内容。
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import random
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / '06_evaluation'

ARMS = ('A1', 'A2', 'E')
REPEATS = ('repeat-1', 'repeat-2')


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def freeze(version: str = '0.1.0') -> dict:
    """冻结对照输入：所有影响结果 determinism 的文件哈希 + 预登记门槛。"""
    files = {}
    for pattern in ('02_contracts/*.json', 'src/haina_travel/*.py',
                    '03_reference/validator.py', 'tests/fixtures/*.json',
                    '06_evaluation/public_case_specs.json', '06_evaluation/PROTOCOL.md'):
        import glob
        for path in sorted(glob.glob(str(ROOT / pattern))):
            rel = Path(path).relative_to(ROOT)
            files[rel.as_posix()] = _sha(Path(path))
    freeze_doc = {
        'schema_version': '0.1.0', 'frozen_on': date.today().isoformat(),
        'version': version,
        'files_sha256': files,
        'arm_config': {
            'A1': '同模型同推理档 + 完整任务要求 + 联网/地图/文件/代码工具 + 公开约束清单',
            'A2': 'A1 + 允许自主写脚本/维护状态/复查修订；不得复制本产品实现',
            'E': '同模型同数据权限 + 本专家（agent+skills+engine，哈希见上）',
            'model_id': 'TO_BE_FROZEN_AT_RUN_TIME（执行前由产品负责人登记）',
            'host_version': 'TO_BE_FROZEN_AT_RUN_TIME',
            'tool_budget': '每组相同：40 次外部调用/失败重试2/修复2轮',
        },
        'decision_thresholds': {
            'human_time_saving_median': '≥30% 且绝对 ≥5 分钟',
            'p0_errors': 0,
            'task_completion': '不低于强基线',
            'unauthorized_locked_changes': 0,
            'adoption_target': '≥6/10',
            'payment_target': '≥3/10',
            'stop_rule': '两轮预设迭代无相对强基线增益 → 停止或缩为免费 Skill',
        },
        'note': '本冻结不含模型 ID 与工具响应快照；两者必须在首次运行前登记，'
                '否则该轮结果记 INCONCLUSIVE。',
    }
    out = EVAL / f'freeze_v{version}.json'
    if out.exists():
        raise FileExistsError(f'冻结文件已存在（不可覆盖）：{out}')
    out.write_text(json.dumps(freeze_doc, ensure_ascii=False, indent=1) + '\n',
                   encoding='utf-8')
    return freeze_doc


def build_registry(version: str = '0.1.0') -> dict:
    """12 公开案例 × 3 臂 × 2 次 = 72 条 NOT_RUN 登记（新文件，不改冻结样张）。"""
    cases = json.loads((EVAL / 'public_case_specs.json').read_text(encoding='utf-8'))['cases']
    rows = []
    for case in cases:
        for arm in ARMS:
            for repeat in REPEATS:
                rows.append({
                    'schema_version': '0.1.0', 'case_id': case['case_id'], 'arm': arm,
                    'status': 'NOT_RUN', 'model_id': None, 'host_version': None,
                    'prompt_hash': None, 'snapshot_id': None, 'seed_label': repeat,
                    'human_active_seconds': None, 'critical_errors': None,
                    'task_completed': None, 'adopted_in_real_trip': None,
                    'artifact_path': None,
                    'reviewer_notes': '待冻结模型/工具响应并执行；此条不是测评结果。'})
    out = EVAL / f'runs_v{version}.jsonl'
    if out.exists():
        raise FileExistsError(f'登记文件已存在（不可覆盖）：{out}')
    with out.open('w', encoding='utf-8') as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + '\n')
    return {'registry': str(out), 'rows': len(rows)}


def update_registry_row(version: str, case_id: str, arm: str, seed_label: str,
                        updates: dict) -> dict:
    """只允许更新指定行；重复执行按 request 语义整体重写该行（保留其余不动）。"""
    out = EVAL / f'runs_v{version}.jsonl'
    rows = [json.loads(line) for line in out.read_text(encoding='utf-8').splitlines() if line]
    hit = 0
    for row in rows:
        if (row['case_id'], row['arm'], row['seed_label']) == (case_id, arm, seed_label):
            allowed = ({'status', 'model_id', 'host_version', 'prompt_hash', 'snapshot_id',
                        'human_active_seconds', 'critical_errors', 'task_completed',
                        'adopted_in_real_trip', 'artifact_path', 'reviewer_notes'}
                       & set(updates))
            row.update({k: updates[k] for k in allowed})
            hit += 1
    if not hit:
        raise KeyError(f'未找到行：{case_id}/{arm}/{seed_label}')
    tmp = out.with_suffix('.jsonl.tmp')
    tmp.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows),
                   encoding='utf-8')
    tmp.replace(out)
    return {'updated': hit}


def run_offline_smoke(version: str = '0.1.0', case_id: str | None = None) -> dict:
    """E 臂离线管道冒烟：证明引擎路径可执行、可复现（同输入同输出哈希）。

    产物写 work/bench/，登记文件不动（这不算对照运行）。
    """
    from .pipeline import apply_change, audit, build_plan
    from .guards import TaskBudget
    from .providers import SnapshotProvider
    fixed_now = '2026-09-18T12:00:00+08:00'   # 确定性冒烟用冻结时钟
    cases = json.loads((EVAL / 'public_case_specs.json').read_text(encoding='utf-8'))['cases']
    selected = [c for c in cases if (case_id is None or c['case_id'] == case_id)]
    out_dir = ROOT / 'work' / 'bench' / 'offline-smoke'
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for case in selected:
        ref = (EVAL / case['input_plan_ref']).resolve()
        plan = json.loads(ref.read_text(encoding='utf-8'))
        if case['task_type'] == 'AUDIT':
            result = audit(plan, now=fixed_now)
            payload = {'kind': 'AUDIT', 'result': result}
        elif case['task_type'] == 'REPLAN':
            extra = ROOT / '04_samples' / 'change_request.json'
            change = json.loads(extra.read_text(encoding='utf-8')) if extra.is_file() else None
            edits = {'slots': [], 'lodgings': []}
            result = apply_change(plan, change, edits, now=fixed_now) \
                if change else {'error': 'NO_CHANGE_FIXTURE'}
            payload = {'kind': 'REPLAN', 'result': result}
        else:
            bp = json.loads((ROOT / 'tests' / 'fixtures' / 'blueprint_smoke.json')
                            .read_text(encoding='utf-8'))
            built, report, _ = build_plan(bp, SnapshotProvider(ROOT / 'work' / 'snapshots'),
                                          TaskBudget(), now=fixed_now)
            payload = {'kind': 'PLAN', 'decision': report['decision'],
                       'issues': report['issues']}
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True) + '\n'
        digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
        artifact = out_dir / f"{case['case_id']}.json"
        if not artifact.exists():   # 只新增，可复现性由哈希对比判断
            artifact.write_text(text, encoding='utf-8')
        prior = hashlib.sha256(artifact.read_bytes()).hexdigest()
        results.append({'case_id': case['case_id'], 'task_type': case['task_type'],
                        'deterministic': prior == digest,
                        'artifact': str(artifact.relative_to(ROOT))})
    return {'mode': 'OFFLINE_ENGINE_SMOKE（不计入对照结论）', 'results': results}


def review_sheet(version: str = '0.1.0', seed: int = 20260918) -> dict:
    """匿名成对评审表：随机展示顺序（固定种子可复现），双评审列。"""
    cases = json.loads((EVAL / 'public_case_specs.json').read_text(encoding='utf-8'))['cases']
    rng = random.Random(seed)
    rows = []
    for case in cases:
        order = ['A1', 'A2', 'E']
        rng.shuffle(order)
        for idx, arm in enumerate(order, start=1):
            rows.append({'case_id': case['case_id'], 'show_position': idx,
                         'arm': arm, 'reviewer_1_score': '', 'reviewer_2_score': '',
                         'notes': ''})
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    out = EVAL / f'review_sheet_v{version}.csv'
    if out.exists():
        raise FileExistsError(f'评审表已存在（不可覆盖）：{out}')
    out.write_text(buf.getvalue(), encoding='utf-8')
    return {'sheet': str(out), 'rows': len(rows), 'seed': seed}


def holdout_template(version: str = '0.1.0') -> dict:
    """留出集模板：由非实现者制作 30 任务；本模板只定义形状与纪律。"""
    doc = {
        'schema_version': '0.1.0', 'status': 'NOT_PREPARED',
        'owner_role': '非实现者（独立测试者）',
        'count': 30,
        'composition': {'PLAN': 10, 'AUDIT': 10, 'REPLAN': 10},
        'rules': [
            '不得使用 12 个公开案例及其衍生；不得用交接包 04_samples 反例原题。',
            '制作完成后整包哈希冻结；调试期间不得改动。',
            '任务需附可独立核查的关键事实清单（营业/预约/交通口径）。',
        ],
        'tasks': [],
    }
    out = EVAL / f'holdout_spec_v{version}.json'
    if out.exists():
        raise FileExistsError(f'留出集模板已存在（不可覆盖）：{out}')
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    return {'template': str(out), 'status': doc['status']}
