#!/usr/bin/env python3
"""从 09_workbuddy_expert/ + src/ 确定性构建 WorkBuddy 宿主插件包（纯标准库）。

产出 dist/host-plugin/freight-reconciliation/，布局对齐平台包格式：
  .codebuddy-plugin/plugin.json   平台清单（expertType=agent）
  .mcp.json                       本地 stdio 连接器（${CODEBUDDY_PLUGIN_ROOT} 自定位）
  agents/freight-reconciliation.md 专家正文（frontmatter+正文）
  skills/<三技能>/SKILL.md
  engine/freight_core/            Core 副本（打包后自包含）
  engine/adapters/mcp_server.py   连接器代码副本
  engine/adapters/admin_server.py 本地人工确认管理页
  engine/02_contracts/            工具输入契约副本（tools/list 用）
  engine/mcp_main.py              打包布局启动器
  scripts/mcp-stdio.sh            自定位执行壳（venv 优先 ~/.cache/freight-reconciliation）
  scripts/admin-local.sh          人工确认管理页启动器（需设置 FREIGHT_ADMIN_TOKEN）
  requirements.txt

构建不修改源码树；含本机绝对路径/占位符泄漏即失败。
可选 --setup-venv：创建 ~/.cache/freight-reconciliation/venv 并安装锁定依赖（宿主实机验证用）。
"""
from __future__ import annotations

import argparse
import json
import shutil
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist" / "host-plugin" / "freight-reconciliation"
NAME = "freight-reconciliation"
VERSION = "0.3.0"

LEAK_PATTERNS = ("/Users/", "REPLACE_WITH_", "HANDOFF_DELTA", "MANIFEST.sha256")

SKILLS = ("freight-intake-and-rules", "freight-reconcile-and-explain",
          "freight-review-and-export")


def fail(msg: str) -> None:
    raise SystemExit(f"build_host_package: {msg}")


def copy_tree(src: Path, dst: Path) -> None:
    for item in src.rglob("*"):
        if "__pycache__" in item.parts or item.name == ".DS_Store":
            continue
        rel = item.relative_to(src)
        target = dst / rel
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)


def copy_avatar(path: Path) -> None:
    avatar = ROOT / "09_workbuddy_expert" / "avatars" / "haina.png"
    if not avatar.is_file():
        fail("market avatar missing")
    shutil.copy2(avatar, path)


def build() -> None:
    expert = ROOT / "09_workbuddy_expert"
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    # 1) agents/<name>.md：frontmatter + 专家正文
    agent_body = (expert / "expert" / "AGENT.md").read_text(encoding="utf-8")
    agent_body = agent_body.split("# 海纳·物流专家（专家正文）", 1)[1]
    agent_md = f"""---
name: {NAME}
description: Payer-side freight reconciliation expert: import, deterministic re-calculation, evidence-linked differences. Not a payment approver.
displayName:
  zh: 海纳·物流专家
  en: Haina · Logistics Expert
profession:
  zh: 物流运费对账专家
  en: Freight Reconciliation Expert
maxTurns: 40
skills:
  - freight-intake-and-rules
  - freight-reconcile-and-explain
  - freight-review-and-export
---
# 海纳·物流专家（专家正文）{agent_body}"""
    (OUT / "agents").mkdir()
    (OUT / "agents" / f"{NAME}.md").write_text(agent_md, encoding="utf-8")

    # 2) skills/
    for skill in SKILLS:
        copy_tree(expert / "skills" / skill, OUT / "skills" / skill)

    # 3) engine/：Core + 连接器 + 契约
    copy_tree(ROOT / "src" / "freight_core", OUT / "engine" / "freight_core")
    copy_tree(ROOT / "02_contracts", OUT / "engine" / "02_contracts")
    (OUT / "engine" / "adapters").mkdir()
    (OUT / "engine" / "adapters" / "__init__.py").write_text("", encoding="utf-8")
    shutil.copy2(ROOT / "adapters" / "mcp_server.py",
                 OUT / "engine" / "adapters" / "mcp_server.py")
    shutil.copy2(ROOT / "adapters" / "admin_server.py",
                 OUT / "engine" / "adapters" / "admin_server.py")
    (OUT / "engine" / "mcp_main.py").write_text(
        '"""打包布局启动器：engine/ 即 sys.path 根（构建时生成，勿手改）。"""\n'
        "import sys\n"
        "from pathlib import Path\n"
        "ENGINE = Path(__file__).resolve().parent\n"
        "for p in (str(ENGINE),):\n"
        "    if p not in sys.path:\n"
        "        sys.path.insert(0, p)\n"
        "from adapters.mcp_server import main\n\n"
        'if __name__ == "__main__":\n'
        "    main()\n",
        encoding="utf-8")

    # 4) 自定位执行壳
    scripts = OUT / "scripts"
    scripts.mkdir()
    sh = scripts / "mcp-stdio.sh"
    sh.write_text(
        "#!/bin/bash\n"
        "# 可移植根解析：WorkBuddy 注入 ${CODEBUDDY_PLUGIN_ROOT}，Hermes 等便携宿主\n"
        "# 注入 ${PLUGIN_ROOT}；都没有时按脚本位置回退。三种形态共用本脚本。\n"
        'if [ -n "${CODEBUDDY_PLUGIN_ROOT:-}" ] && [ -d "${CODEBUDDY_PLUGIN_ROOT}/engine" ]; then\n'
        '  ROOT="${CODEBUDDY_PLUGIN_ROOT}"\n'
        'elif [ -n "${PLUGIN_ROOT:-}" ] && [ -d "${PLUGIN_ROOT}/engine" ]; then\n'
        '  ROOT="${PLUGIN_ROOT}"\n'
        "else\n"
        '  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n'
        '  ROOT="$(dirname "$SELF")"\n'
        "fi\n"
        'PY="${FREIGHT_PYTHON:-}"\n'
        'if [ -z "$PY" ]; then\n'
        '  if [ -x "$HOME/.cache/freight-reconciliation/venv/bin/python" ]; then\n'
        '    PY="$HOME/.cache/freight-reconciliation/venv/bin/python"\n'
        "  else\n"
        '    PY="python3"\n'
        "  fi\n"
        "fi\n"
        'export FREIGHT_RECON_ROOT="${FREIGHT_RECON_ROOT:-$HOME/.local/share/freight-reconciliation}"\n'
        'exec "$PY" "$ROOT/engine/mcp_main.py"\n',
        encoding="utf-8")
    sh.chmod(sh.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    admin = scripts / "admin-local.sh"
    admin.write_text(
        "#!/bin/bash\n"
        "set -e\n"
        'if [ -z "${FREIGHT_ADMIN_TOKEN:-}" ]; then\n'
        '  echo "Set FREIGHT_ADMIN_TOKEN before starting the admin page" >&2\n'
        "  exit 1\n"
        "fi\n"
        'ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"\n'
        'PY="${FREIGHT_PYTHON:-$HOME/.cache/freight-reconciliation/venv/bin/python}"\n'
        'export FREIGHT_RECON_ROOT="${FREIGHT_RECON_ROOT:-$HOME/.local/share/freight-reconciliation}"\n'
        'export PYTHONPATH="$ROOT/engine"\n'
        'exec "$PY" "$ROOT/engine/adapters/admin_server.py"\n',
        encoding="utf-8")
    admin.chmod(admin.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    # 4b) Windows 启动脚本（与 sh 同一套可移植根解析）
    ps1 = scripts / "mcp-stdio.ps1"
    ps1.write_text(
        "# portable root resolution: CODEBUDDY_PLUGIN_ROOT -> PLUGIN_ROOT -> script dir\n"
        "$root = $null\n"
        "if ($env:CODEBUDDY_PLUGIN_ROOT -and (Test-Path (Join-Path $env:CODEBUDDY_PLUGIN_ROOT 'engine'))) {\n"
        "  $root = $env:CODEBUDDY_PLUGIN_ROOT\n"
        "} elseif ($env:PLUGIN_ROOT -and (Test-Path (Join-Path $env:PLUGIN_ROOT 'engine'))) {\n"
        "  $root = $env:PLUGIN_ROOT\n"
        "} else {\n"
        "  $root = Split-Path -Parent $PSScriptRoot\n"
        "}\n"
        "$py = $env:FREIGHT_PYTHON\n"
        "if (-not $py) {\n"
        "  $venv = Join-Path $HOME '.cache/freight-reconciliation/venv/Scripts/python.exe'\n"
        "  if (Test-Path $venv) { $py = $venv } else { $py = 'python' }\n"
        "}\n"
        "if (-not $env:FREIGHT_RECON_ROOT) {\n"
        "  $env:FREIGHT_RECON_ROOT = Join-Path $HOME '.local/share/freight-reconciliation'\n"
        "}\n"
        "& $py (Join-Path $root 'engine/mcp_main.py')\n",
        encoding="utf-8")
    cmd = scripts / "mcp-stdio.cmd"
    cmd.write_text(
        "@echo off\r\n"
        "rem thin wrapper: keep logic in mcp-stdio.ps1\r\n"
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0mcp-stdio.ps1\" %*\r\n",
        encoding="utf-8")

    # 5) .mcp.json（stdio，自定位）
    (OUT / ".mcp.json").write_text(json.dumps({
        "mcpServers": {NAME: {
            "type": "stdio",
            "command": "${CODEBUDDY_PLUGIN_ROOT}/scripts/mcp-stdio.sh",
            "args": [],
            "env": {},
            "defer_loading": False,
        }}}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 6) plugin.json
    plugin_json = {
        "name": NAME,
        "version": VERSION,
        "description": "Deterministic freight reconciliation core via local stdio MCP.",
        "license": "MIT",
        "author": {"name": "Haina", "email": "1711496337@qq.com"},
        "agents": [f"./agents/{NAME}.md"],
        "expertType": "agent",
        "agentName": NAME,
        "skills": [f"./skills/{s}" for s in SKILLS],
        "keywords": ["freight", "reconciliation", "logistics"],
        "displayName": {"zh": "海纳·物流专家", "en": "Haina · Logistics Expert"},
        "profession": {"zh": "物流运费对账专家", "en": "Freight Reconciliation Expert"},
        "displayDescription": {
            "zh": "核对运输台账、承运商账单、合同费率与履约凭证，生成可追溯、可复算的运费差异清单，支持人工复核与导出。",
            "en": "Reconcile carrier bills against contracts and evidence; deterministic, auditable differences."},
        "categoryId": "12-IndustryConsultant",
        "avatar": "avatars/haina.png",
        "defaultInitPrompt": {"zh": "把承运商9月账单与运输台账核对。",
                              "en": "Reconcile the bill against trips."},
        "plugin": NAME,
        "tags": [{"zh": "运费对账", "en": "Freight Reconciliation"},
                 {"zh": "差异核对", "en": "Bill Differences"},
                 {"zh": "证据核查", "en": "Evidence Check"}],
        "quickPrompts": [
            {"zh": "把承运商9月账单与运输台账核对。", "en": "Reconcile the bill against trips."},
            {"zh": "为什么这次等待费多了50元？", "en": "Why is the waiting fee higher?"},
            {"zh": "生成发给承运商核对的材料。", "en": "Prepare the reconciliation material."}],
    }
    (OUT / ".codebuddy-plugin").mkdir()
    (OUT / ".codebuddy-plugin" / "plugin.json").write_text(
        json.dumps(plugin_json, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 7) 头像 / requirements / LICENSE / README
    avatars = OUT / "avatars"
    avatars.mkdir()
    copy_avatar(avatars / "haina.png")
    shutil.copy2(ROOT / "LICENSE", OUT / "LICENSE")
    (OUT / "requirements.txt").write_text(
        "jsonschema==4.26.0\nrfc3339-validator==0.1.4\nopenpyxl==3.1.5\n",
        encoding="utf-8")
    (OUT / "README.md").write_text(
        f"# {NAME} 宿主插件包 v{VERSION}\n\n由 scripts/build_host_package.py 确定性构建；"
        "勿手改。需要 Python 3.11+。首次使用先在本机安装锁定依赖：\n\n"
        "```bash\npython3 -m venv ~/.cache/freight-reconciliation/venv\n"
        "~/.cache/freight-reconciliation/venv/bin/pip install -r requirements.txt\n```\n\n"
        "连接器由 .mcp.json 启动。本地人工确认页需单独启动：\n\n"
        "```bash\nread -s -p '管理页口令: ' FREIGHT_ADMIN_TOKEN; echo\n"
        "export FREIGHT_ADMIN_TOKEN\n./scripts/admin-local.sh\n```\n\n"
        "随后访问 http://127.0.0.1:8765/。连接器与管理页须使用同一"
        " FREIGHT_RECON_ROOT；默认 ~/.local/share/freight-reconciliation。"
        "仅在本人电脑运行，勿将案件库放在网络共享盘。\n",
        encoding="utf-8")

    # 8) 泄漏扫描（本机绝对路径/占位符）
    for f in OUT.rglob("*"):
        if f.is_file() and f.suffix in (".md", ".json", ".py", ".sh", ".txt"):
            text = f.read_text(encoding="utf-8", errors="ignore")
            for pat in LEAK_PATTERNS:
                if pat in text:
                    fail(f"leak pattern {pat!r} in {f.relative_to(OUT)}")
    print(f"built: {OUT}")


def setup_venv() -> None:
    venv = Path.home() / ".cache" / "freight-reconciliation" / "venv"
    if not venv.exists():
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
    subprocess.run([str(venv / "bin" / "pip"), "install", "-q",
                    "-r", str(OUT / "requirements.txt")], check=True)
    print(f"venv ready: {venv}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--setup-venv", action="store_true")
    args = parser.parse_args()
    build()
    if args.setup_venv:
        setup_venv()
