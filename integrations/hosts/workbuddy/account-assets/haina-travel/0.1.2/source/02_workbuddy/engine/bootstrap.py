#!/usr/bin/env python3
"""海纳·旅行专家引擎引导器（WorkBuddy 沙箱内运行）。

硬规则（与 agent 提示词一致）：
- 自定位：全部路径基于本文件位置，不依赖 cwd；
- 零删除、零改名（零 mv、零 rmtree）；venv 只建在 ~/.cache/haina-travel/；
- 失败即停止：依赖不可用时报错退出，绝不自行"修环境"（删除重装、反复重试）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent
VENV = Path.home() / '.cache' / 'haina-travel' / 'venv'
REQUIREMENTS = ENGINE_DIR / 'requirements-engine.txt'
MARKER = VENV / '.deps-ok'


def _candidate_pythons() -> list[str]:
    """优先级：当前解释器 → WorkBuddy 托管 Python（≥3.10）→ 系统 python3。"""
    out = [sys.executable]
    wb = Path.home() / '.workbuddy' / 'binaries' / 'python' / 'versions'
    current = wb / 'current'
    if current.is_file():
        ver = current.read_text(encoding='utf-8').strip()
        out.append(str(wb / ver / 'bin' / 'python3'))
    out.append('/usr/bin/python3')
    out.append('python3')
    seen, uniq = set(), []
    for item in out:
        if item and item not in seen:
            seen.add(item)
            uniq.append(item)
    return uniq


def deps_importable(python: str) -> bool:
    if not (Path(python).is_file() or Path(python + '.exe').is_file()):
        return False
    code = "import jsonschema, referencing, rfc3339_validator"
    try:
        return subprocess.run([python, '-c', code],
                              capture_output=True).returncode == 0
    except OSError:
        return False


def _py_version(python: str) -> tuple:
    proc = subprocess.run([python, '-c',
                           'import sys;print(sys.version_info[:2])'],
                          capture_output=True, text=True)
    try:
        return tuple(int(x) for x in proc.stdout.strip('()\n ').split(','))
    except ValueError:
        return (0, 0)


def _stop(payload: dict):
    sys.stderr.write(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(3)


def ensure_runtime() -> str:
    """返回可用的 python 路径。零删除纪律：绝不删 venv；装依赖失败即停并给出人工步骤。"""
    for python in _candidate_pythons():
        if deps_importable(python):
            return python
    venv_python = str(VENV / 'bin' / 'python')
    if deps_importable(venv_python):
        return venv_python
    if VENV.exists() and (VENV / 'bin' / 'pip').exists():
        # 幂等重装一次（不是删除重建）；失败即停，交人工处理
        proc = subprocess.run([str(VENV / 'bin' / 'pip'), 'install', '-q', '-r',
                               str(REQUIREMENTS)], capture_output=True, text=True)
        if proc.returncode == 0 and deps_importable(venv_python):
            MARKER.write_text('ok\n', encoding='utf-8')
            return venv_python
        _stop({'error': 'ENGINE_DEPS_UNAVAILABLE',
               'message': f'已有 venv（{VENV}）依赖不可用，且一次幂等重装未成功；'
                          f'本引导器被禁止删除或重建环境。请用户在终端手动处理：'
                          f'检查 {VENV}/bin/python 版本（需 ≥3.10），或删除该目录后重试。',
               'pip_tail': (proc.stderr or proc.stdout)[-300:]})
    if not REQUIREMENTS.is_file():
        _stop({'error': 'REQUIREMENTS_MISSING', 'message': str(REQUIREMENTS)})
    base = None
    for python in _candidate_pythons():
        try:
            if _py_version(python) >= (3, 10):
                base = python
                break
        except OSError:
            continue
    if base is None:
        _stop({'error': 'NO_SUITABLE_PYTHON',
               'message': '未找到 ≥3.10 的 Python；需要用户安装或授权使用托管 Python。'})
    proc = subprocess.run([base, '-m', 'venv', str(VENV)], capture_output=True, text=True)
    if proc.returncode != 0:
        _stop({'error': 'VENV_CREATE_FAILED', 'message': proc.stderr[-400:]})
    pip = VENV / 'bin' / 'pip'
    proc = subprocess.run([str(pip), 'install', '-q', '-r', str(REQUIREMENTS)],
                          capture_output=True, text=True)
    if proc.returncode != 0 or not deps_importable(venv_python):
        _stop({'error': 'PIP_INSTALL_FAILED',
               'message': (proc.stderr or proc.stdout)[-400:] +
                          '；请用户在终端手动完成依赖安装后重试。'})
    MARKER.write_text('ok\n', encoding='utf-8')
    return venv_python
    if not REQUIREMENTS.is_file():
        sys.stderr.write(json.dumps({'error': 'REQUIREMENTS_MISSING',
                                     'message': str(REQUIREMENTS)}, ensure_ascii=False))
        raise SystemExit(3)
    proc = subprocess.run([sys.executable, '-m', 'venv', str(VENV)], capture_output=True,
                          text=True)
    if proc.returncode != 0:
        sys.stderr.write(json.dumps({'error': 'VENV_CREATE_FAILED',
                                     'message': proc.stderr[-400:]}, ensure_ascii=False))
        raise SystemExit(3)
    pip = VENV / 'bin' / 'pip'
    proc = subprocess.run([str(pip), 'install', '-q', '-r', str(REQUIREMENTS)],
                          capture_output=True, text=True)
    if proc.returncode != 0 or not deps_importable(str(VENV / 'bin' / 'python')):
        sys.stderr.write(json.dumps({'error': 'PIP_INSTALL_FAILED',
                                     'message': (proc.stderr or proc.stdout)[-400:]},
                                    ensure_ascii=False))
        raise SystemExit(3)
    MARKER.write_text('ok\n', encoding='utf-8')
    return str(VENV / 'bin' / 'python')


def main() -> int:
    python = ensure_runtime()
    env = dict(os.environ)
    env['PYTHONPATH'] = str(ENGINE_DIR) + os.pathsep + env.get('PYTHONPATH', '')
    proc = subprocess.run([python, '-m', 'haina_travel.cli', *sys.argv[1:]],
                          env=env, capture_output=True, text=True)
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr[-800:] if proc.returncode != 0 else '')
    return proc.returncode


if __name__ == '__main__':
    raise SystemExit(main())
