"""数据提供方：冻结快照（离线/对照）与高德 REST（实机）双实现。

统一约束（设计 8.2）：
- 返回 ToolResult；PARTIAL 不等于 OK；
- 失败保留候选并要求确认，关键段标未知，不填经验精确值；
- 每次调用计入 TaskBudget；原始响应落盘 work/raw/（脱敏，不写密钥）。
快照模式用于离线开发、回归与 M3 冻结对照（同快照同输入 = 同结果）。
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .guards import BudgetExceeded, TaskBudget
from .results import make_result, now_iso

AMAP_BASE = 'https://restapi.amap.com/v3'


class ProviderError(RuntimeError):
    pass


class SnapshotProvider:
    """从快照目录回放工具响应。快照文件 = ToolResult JSON。
    目录约定：<root>/<tool>/<query_key>.json；root 默认 work/snapshots。
    record=True 时把 AmapProvider 的真实响应写进来（制快照），之后只读回放。
    """

    def __init__(self, root: Path, budget: TaskBudget | None = None):
        self.root = Path(root)
        self.budget = budget
        self._counter = 0

    def _path(self, tool: str, key: str) -> Path:
        digest = hashlib.sha256(key.encode('utf-8')).hexdigest()[:12]
        safe = ''.join(c if c.isalnum() or c in '-_' else '_' for c in key)[:60]
        return self.root / tool / f'{safe}__{digest}.json'

    def call(self, tool: str, params: dict) -> dict:
        if self.budget:
            self.budget.charge_call(tool)
        self._counter += 1
        request_id = f'snap-{self._counter:04d}'
        path = self._path(tool, json.dumps(params, ensure_ascii=False, sort_keys=True))
        if not path.is_file():
            return make_result(tool, request_id, 'UNAVAILABLE', None,
                               error_code='SNAPSHOT_MISS', retryable=False)
        result = json.loads(path.read_text(encoding='utf-8'))
        result['request_id'] = request_id
        return result

    def store(self, tool: str, params: dict, result: dict) -> Path:
        """制快照：写入（存在则拒绝覆盖——快照一经冻结不可变）。"""
        path = self._path(tool, json.dumps(params, ensure_ascii=False, sort_keys=True))
        if path.exists():
            raise FileExistsError(f'快照已冻结，拒绝覆盖：{path}')
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + '.tmp')
        tmp.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.link(tmp, path)
        tmp.unlink()
        return path


class AmapProvider:
    """高德 REST 适配（v3 地点/路线/天气）。无 KEY、失败、限流一律诚实返回。

    需要：AMAP_KEY 环境变量，或 ~/.local/share/haina-travel/config.json 的
    {"amap_key": "..."}（用户在可信环境自行配置；引擎不落地密钥）。
    商用许可与配额由账号方决定，探针报告只记录实测，不预设。
    """

    TOOL_PATH = {
        'PLACE_SEARCH': '/place/text',
        'PLACE_DETAIL': '/place/detail',
        'ROUTE': '/direction',
        'WEATHER': '/weather/weatherInfo',
    }

    def __init__(self, budget: TaskBudget | None = None, key: str | None = None,
                 raw_dir: Path | None = None, timeout: int = 15):
        self.key = key or self._load_key()
        self.budget = budget
        self.raw_dir = Path(raw_dir) if raw_dir else None
        self.timeout = timeout
        self._counter = 0

    @staticmethod
    def _load_key() -> str | None:
        if os.environ.get('AMAP_KEY'):
            return os.environ['AMAP_KEY']
        cfg = Path.home() / '.local' / 'share' / 'haina-travel' / 'config.json'
        if cfg.is_file():
            try:
                return json.loads(cfg.read_text(encoding='utf-8')).get('amap_key')
            except (ValueError, OSError):
                return None
        return None

    @property
    def configured(self) -> bool:
        return bool(self.key)

    def call(self, tool: str, params: dict) -> dict:
        if tool not in self.TOOL_PATH:
            # 工具名不在 ToolResult 枚举内属程序错误：拒绝服务而不是伪造信封
            raise ProviderError(f'未知工具：{tool}')
        if not self.configured:
            return make_result(tool, 'amp-0', 'DENIED', None,
                               error_code='AMAP_KEY_MISSING', retryable=False)
        if self.budget:
            self.budget.charge_call(tool)
        self._counter += 1
        request_id = f'amp-{self._counter:04d}'
        query = dict(params)
        query['key'] = self.key
        url = AMAP_BASE + self.TOOL_PATH[tool] + '?' + urllib.parse.urlencode(query)
        attempts = 0
        while True:
            attempts += 1
            try:
                with urllib.request.urlopen(url, timeout=self.timeout) as resp:
                    body = json.loads(resp.read().decode('utf-8'))
                self._dump_raw(request_id, tool, body)
                status, err, retryable = self._interpret(body)
                return make_result(tool, request_id, status, body, error_code=err,
                                   retryable=retryable, billing_currency='CNY')
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if self.budget and attempts <= TaskBudget.MAX_RETRIES:
                    try:
                        self.budget.charge_retry(tool)
                    except BudgetExceeded as stop:
                        return make_result(tool, request_id, 'UNAVAILABLE', None,
                                           error_code='BUDGET_STOP', retryable=False,
                                           provider_trace_id=str(exc))
                    continue
                return make_result(tool, request_id, 'UNAVAILABLE', None,
                                   error_code='NETWORK', retryable=False,
                                   provider_trace_id=str(exc)[:200])
            except ValueError as exc:   # JSON 解码失败
                return make_result(tool, request_id, 'PARTIAL', None,
                                   error_code='BAD_RESPONSE', retryable=False,
                                   provider_trace_id=str(exc)[:200])

    def _interpret(self, body: dict) -> tuple[str, str | None, bool]:
        info = str(body.get('infocode', ''))
        status = str(body.get('status', '0'))
        if status == '1':
            if info == '10000':
                return 'OK', None, False
            return 'PARTIAL', f'INFOCODE_{info}', False
        if info in ('10021', '10020', '10019'):       # 配额/限流类
            return 'RATE_LIMITED', f'INFOCODE_{info}', True
        if info in ('10001', '10003'):                # key 非法/过期
            return 'DENIED', f'INFOCODE_{info}', False
        return 'UNAVAILABLE', f'INFOCODE_{info}', True

    def _dump_raw(self, request_id: str, tool: str, body: dict) -> None:
        if not self.raw_dir:
            return
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        payload = dict(body)
        if isinstance(payload.get('key'), str):       # 高德回显不带回显 key，双保险
            payload['key'] = 'REDACTED'
        (self.raw_dir / f'{request_id}-{tool}.json').write_text(
            json.dumps(payload, ensure_ascii=False) + '\n', encoding='utf-8')
