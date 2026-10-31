#!/usr/bin/env bash
set -euo pipefail

if [ -f "pyproject.toml" ] && grep -q "wechat-social-assistant" "pyproject.toml"; then
  python3 -m pip install -e .
else
  python3 -m pip install "git+https://github.com/harrylabsj/wechat-social-assistant.git"
fi

python3 -m wsa.cli status
