"""成本与故障守卫：验证期预算（设计第 11 章）。

单任务默认：最多 40 次外部调用、每项失败至多重试 2 次、计划修复至多 2 轮。
重试计入总额；超限抛 BudgetExceeded，由上层降级交付已取得成果。
"""
from __future__ import annotations

import time


class BudgetExceeded(RuntimeError):
    def __init__(self, message: str, partial):
        super().__init__(message)
        self.partial = partial


class TaskBudget:
    MAX_CALLS = 40
    MAX_RETRIES = 2
    MAX_FIX_ROUNDS = 2
    MAX_SECONDS = 600

    def __init__(self, max_calls: int = MAX_CALLS, max_seconds: int = MAX_SECONDS):
        self.max_calls = max_calls
        self.max_seconds = max_seconds
        self.calls = 0
        self.retries = 0
        self.started = time.monotonic()

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started

    def charge_call(self, tool: str) -> None:
        self.calls += 1
        if self.calls > self.max_calls:
            raise BudgetExceeded(
                f'外部调用超限（{tool}：{self.calls}/{self.max_calls}），停止并交付已取得成果。',
                partial=True)

    def charge_retry(self, tool: str) -> None:
        self.retries += 1
        if self.retries > self.MAX_RETRIES:
            raise BudgetExceeded(f'{tool} 重试超限（>{self.MAX_RETRIES}），停止重试。', partial=True)

    def charge_fix_round(self) -> None:
        if self.elapsed > self.max_seconds:
            raise BudgetExceeded(f'任务耗时 {self.elapsed:.0f}s 超过上限 {self.max_seconds}s。', partial=True)

    def snapshot(self) -> dict:
        return {'external_calls': self.calls, 'retries': self.retries,
                'elapsed_seconds': round(self.elapsed, 1),
                'limits': {'max_calls': self.max_calls, 'max_retries': self.MAX_RETRIES,
                           'max_fix_rounds': self.MAX_FIX_ROUNDS, 'max_seconds': self.max_seconds}}
