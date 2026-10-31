"""旅行状态：版本链 + 乐观版本检查 + request_id 幂等。

验证期单用户本地存储（设计 8.3）：默认 ~/.local/share/haina-travel/，
测试与基准用 HAINA_TRAVEL_HOME 覆盖。零删除、零改名：只新增文件与索引。
CHECKED/ACCEPTED 由可信程序（本引擎）依据检查报告/用户操作写入，
模型自报不生效（validate_plan 的 STATUS_OVERCLAIM 仍在交付前兜底）。

已知限制：commit_new_version 先写版本文件、后更新 index；两步之间崩溃会让该
版本号永久卡住（零删除策略下不自动恢复）——需人工把 index.current_version 指向
该版本，或改用下一个版本号重新提交。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .schemas import validate_schema


def default_home() -> Path:
    root = os.environ.get('HAINA_TRAVEL_HOME')
    return Path(root) if root else Path.home() / '.local' / 'share' / 'haina-travel'


class VersionConflict(RuntimeError):
    pass


class TripStore:
    """目录布局：
    <home>/trips/<trip_id>/v<N>.json          各版本行程（只新增）
    <home>/trips/<trip_id>/index.json         当前版本指针 + 状态 + request_id 台账
    """

    def __init__(self, home: Path | None = None):
        self.home = Path(home) if home else default_home()

    # ---- 路径 ----
    def trip_dir(self, trip_id: str) -> Path:
        return self.home / 'trips' / trip_id

    def index_path(self, trip_id: str) -> Path:
        return self.trip_dir(trip_id) / 'index.json'

    # ---- 读取 ----
    def load_index(self, trip_id: str) -> dict:
        path = self.index_path(trip_id)
        if not path.is_file():
            return {'trip_id': trip_id, 'current_version': 0, 'status': 'DRAFT',
                    'request_ids': {}, 'history': []}
        return json.loads(path.read_text(encoding='utf-8'))

    def load_version(self, trip_id: str, version: int) -> dict:
        path = self.trip_dir(trip_id) / f'v{version}.json'
        if not path.is_file():
            raise FileNotFoundError(f'版本不存在：{trip_id} v{version}')
        return json.loads(path.read_text(encoding='utf-8'))

    def load_current(self, trip_id: str) -> tuple[dict, dict]:
        index = self.load_index(trip_id)
        if index['current_version'] == 0:
            raise FileNotFoundError(f'尚无任何版本：{trip_id}')
        return self.load_version(trip_id, index['current_version']), index

    def list_versions(self, trip_id: str) -> list[dict]:
        index = self.load_index(trip_id)
        return index['history']

    # ---- 写入（只新增）----
    def _write_atomic_create(self, path: Path, text: str) -> None:
        """只新增文件的原子写：目标存在即失败（永不覆盖版本文件）。"""
        if path.exists():
            raise FileExistsError(f'拒绝覆盖已存在文件：{path}')
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + f'.tmp-{os.getpid()}')
        tmp.write_text(text, encoding='utf-8')
        try:
            os.link(tmp, path)   # 原子创建，存在即失败
        except FileExistsError:
            raise
        finally:
            try:
                tmp.unlink()     # 只删自己刚建的 tmp，属沙箱允许的自我清理
            except FileNotFoundError:
                pass

    def commit_new_version(self, plan: dict, *, status: str | None = None,
                           request_id: str | None = None,
                           note: str = '') -> dict:
        """提交一个新版本：trip_id/version 必须是 next；expected 冲突抛 VersionConflict。

        request_id 幂等：同一 request_id 重复提交返回首次结果，不产生新版本。
        """
        trip_id = plan['trip_id']
        validate_schema('itinerary', plan)
        index = self.load_index(trip_id)
        if request_id and request_id in index['request_ids']:
            prior = index['request_ids'][request_id]
            return {'idempotent': True, 'version': prior['version'],
                    'status': prior['status'], 'plan': self.load_version(trip_id, prior['version'])}
        expected_next = index['current_version'] + 1
        if plan['version'] != expected_next:
            raise VersionConflict(
                f'版本冲突：当前 v{index["current_version"]}，提交要求 v{plan["version"]}，'
                f'应为 v{expected_next}。请基于当前版本重新生成。')
        path = self.trip_dir(trip_id) / f'v{plan["version"]}.json'
        self._write_atomic_create(path, json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
        new_status = status or self._derive_status(plan)
        index['current_version'] = plan['version']
        index['status'] = new_status
        index['history'].append({'version': plan['version'], 'status': new_status,
                                 'note': note, 'request_id': request_id})
        if request_id:
            index['request_ids'][request_id] = {'version': plan['version'], 'status': new_status}
        self._replace_index(trip_id, index)
        return {'idempotent': False, 'version': plan['version'], 'status': new_status,
                'plan': plan}

    def _replace_index(self, trip_id: str, index: dict) -> None:
        """index.json 是唯一允许原地重写的文件（指针语义）；仍用 link 原子替换。"""
        path = self.index_path(trip_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f'index.json.tmp-{os.getpid()}-{len(index["history"])}')
        tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(tmp, path)

    @staticmethod
    def _derive_status(plan: dict) -> str:
        """可信程序依据检查报告推导状态；模型自报的 planning_status 一律不采信
        （虚高标称由 validate_plan_report 的 STATUS_OVERCLAIM 在检查层拦截）。"""
        from .checks import validate_plan_report
        report = validate_plan_report(plan)
        return {'CHECKED_PLANNING': 'CHECKED', 'CONDITIONAL': 'CONDITIONAL',
                'BLOCKED': 'NEEDS_REPLAN'}[report['decision']]

    def mark_accepted(self, trip_id: str, version: int, request_id: str) -> dict:
        """ACCEPTED 只能由用户选择操作写入（模型不能自报）。"""
        index = self.load_index(trip_id)
        if version != index['current_version']:
            raise VersionConflict(f'只能接受当前版本 v{index["current_version"]}')
        index['status'] = 'ACCEPTED'
        index['history'][-1]['status'] = 'ACCEPTED'
        index['request_ids'][request_id] = {'version': version, 'status': 'ACCEPTED'}
        self._replace_index(trip_id, index)
        return index
