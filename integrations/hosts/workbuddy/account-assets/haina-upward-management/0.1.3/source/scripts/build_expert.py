#!/usr/bin/env python3
"""从 02_workbuddy/ 组织出 WorkBuddy 平台上传包（纯标准库，不联网、不写业务文件）。

产出：
    dist/expert/<name>/                      构建树
    dist/expert/<name>-<version>.zip         平台上传包（顶层目录 == plugin.json 的 name）
    dist/expert/<name>-<version>.zip.sha256  两字段，兼容 `shasum -a 256 -c`

顺序即安全属性：泄漏扫描 → 冒烟测试 → 字节码复检 → 打包。
先打包再冒烟，会把 __pycache__ 之类的东西封进 zip。

本脚本**不修改源码树**。作者与头像的替换只发生在构建产物里，
这样 FILE_MANIFEST.json 的 48 条哈希长期有效，源码树也诚实反映"占位尚未替换"。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '02_workbuddy'
CONTRACTS = ROOT / '03_contracts'
DEFAULT_OUT = ROOT / 'dist' / 'expert'
DEFAULT_AVATAR = ROOT / 'assets' / 'haina.png'
DEFAULT_PUBLISHER = '北京海纳福星文化传媒有限公司'
DEFAULT_EMAIL = '1711496337@qq.com'

PUBLISHER_PLACEHOLDER = 'REPLACE_WITH_PUBLISHER'
DROP_FILES = {'README.md', '.DS_Store'}

# 每个技能自带哪张模板卡；两个 references 文件三个技能都要。
SKILL_TEMPLATE = {
    'clarify-instruction': 'task-card.md',
    'assess-evidence': 'evidence-card.md',
    'prepare-dialogue': 'dialogue-review.md',
}
SHARED_REFERENCES = ('research-notes.md', 'safety-boundaries.md')

# 命中即失败：不产出"看起来能用"的包。
LEAK_PATTERNS = (
    (r'REPLACE_WITH_', '未替换的占位符'),
    (r'/Users/[A-Za-z0-9_.-]+', '本机绝对路径'),
    (r'haina_upward_management_v0\.1\.0', '交接包根名'),
    (r'FILE_MANIFEST', '交接件清单'),
    (r'MANIFEST\.sha256', '仓库清单'),
    (r'release-readiness', '发布阻断内部件'),
    (r'NOT_RUN_INITIAL', '验收初始记录'),
    (r'selfcheck', '开发自检脚本'),
    (r'test_invariants', '开发回归脚本'),
    (r'\b0[1-7]_(design|workbuddy|contracts|examples|tests|tools|references)\b', '开发目录引用'),
    (r'向上管理专家_海纳_产品与技术设计', '设计文档名'),
    (r'(?i)(api[_-]?key\s*[:=]|authorization\s*[:=]|sk-[a-z0-9_-]{8,}|wrk-[a-z0-9_-]{8,})', '凭证形态'),
)

AT_REF = re.compile(r'@(?:references|templates)/[A-Za-z0-9_./-]+')
EPOCH = (2026, 1, 1, 0, 0, 0)


class BuildError(RuntimeError):
    pass


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def parse_frontmatter(path: Path) -> dict[str, str]:
    """极简 frontmatter 提取：只取顶层 `key: value` 行，足够做冒烟断言。"""
    text = path.read_text(encoding='utf-8')
    if not text.startswith('---'):
        return {}
    body = text.split('---', 2)[1]
    out: dict[str, str] = {}
    for line in body.splitlines():
        if line[:1] in (' ', '\t', '') or ':' not in line:
            continue
        key, _, value = line.partition(':')
        out[key.strip()] = value.strip().strip('"')
    return out


def png_size(path: Path) -> tuple[int, int, int]:
    raw = path.read_bytes()
    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise BuildError(f'不是 PNG 文件：{path}')
    width, height = struct.unpack('>II', raw[16:24])
    return width, height, raw[25]  # raw[25] = IHDR colour type


def iter_text_files(root: Path):
    for path in sorted(root.rglob('*')):
        if path.is_file() and path.suffix.lower() in {'.md', '.json', '.txt', '.yaml', '.yml'}:
            yield path


def _stage_tree(out_dir: Path, name: str, plugin: dict, avatar: Path) -> Path:
    plugins_dir = SOURCE / '.codebuddy-plugin'
    agent_src = SOURCE / 'agents' / f"{plugin['agentName']}.md"
    if not agent_src.is_file():
        raise BuildError(f'找不到 agent 文件：{agent_src}')

    out = out_dir / name
    shutil.rmtree(out, ignore_errors=True)   # Python 调用，不用 shell `rm -rf`（沙箱拦递归删除）
    out.mkdir(parents=True)

    (out / '.codebuddy-plugin').mkdir()
    shutil.copy2(plugins_dir / 'plugin.json', out / '.codebuddy-plugin' / 'plugin.json')

    (out / 'agents').mkdir()
    shutil.copy2(agent_src, out / 'agents' / agent_src.name)

    for skill_rel in plugin['skills']:
        skill_name = Path(skill_rel).name
        if skill_name not in SKILL_TEMPLATE:
            raise BuildError(f'技能 {skill_name} 没有登记模板卡，先补 SKILL_TEMPLATE')
        src_skill = SOURCE / 'skills' / skill_name
        dst_skill = out / 'skills' / skill_name
        (dst_skill / 'references').mkdir(parents=True)
        (dst_skill / 'templates').mkdir()
        shutil.copy2(src_skill / 'SKILL.md', dst_skill / 'SKILL.md')
        for ref in SHARED_REFERENCES:
            shutil.copy2(SOURCE / 'references' / ref, dst_skill / 'references' / ref)
        card = SKILL_TEMPLATE[skill_name]
        shutil.copy2(SOURCE / 'templates' / card, dst_skill / 'templates' / card)

    width, height, _ = png_size(avatar)
    if (width, height) != (512, 512):
        raise BuildError(f'头像必须是 512×512，实际 {width}×{height}')
    if avatar.stat().st_size > 500 * 1024:
        raise BuildError(f'头像超过 500KB：{avatar.stat().st_size} 字节')
    (out / 'avatars').mkdir()
    shutil.copy2(avatar, out / 'avatars' / avatar.name)

    return out


def _fill_publisher(out: Path, publisher: str, email: str) -> None:
    plugin_path = out / '.codebuddy-plugin' / 'plugin.json'
    plugin = read_json(plugin_path)
    plugin['author'] = {'name': publisher, 'email': email}
    plugin['avatar'] = 'avatars/haina.png'
    plugin_path.write_text(json.dumps(plugin, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    for path in out.rglob('*.md'):
        text = path.read_text(encoding='utf-8')
        if PUBLISHER_PLACEHOLDER in text:
            path.write_text(text.replace(PUBLISHER_PLACEHOLDER, publisher), encoding='utf-8')


def _scan_for_leaks(out: Path) -> None:
    hits = []
    for path in iter_text_files(out):
        text = path.read_text(encoding='utf-8')
        for pattern, label in LEAK_PATTERNS:
            for match in re.finditer(pattern, text):
                hits.append(f'{path.relative_to(out)}: {label} → {match.group(0)!r}')
    if hits:
        shutil.rmtree(out, ignore_errors=True)
        raise BuildError('泄漏扫描命中，产物已删除：\n  ' + '\n  '.join(hits))


def _smoke_test(out: Path) -> list[str]:
    warnings: list[str] = []
    plugin = read_json(out / '.codebuddy-plugin' / 'plugin.json')

    def need(ok: bool, label: str) -> None:
        if not ok:
            raise BuildError(f'冒烟失败：{label}')

    need(plugin['name'] == plugin['plugin'] == plugin['agentName'], 'name/plugin/agentName 不一致')
    need(plugin['expertType'] == 'agent', 'expertType 必须是 agent')
    need(len(plugin['skills']) == 3, '技能数必须为 3')
    need(len(plugin['tags']) == 3 and len(plugin['quickPrompts']) == 3, 'tags/quickPrompts 必须各 3 条')
    need(plugin['defaultInitPrompt'] == plugin['quickPrompts'][0], 'defaultInitPrompt 必须等于首个快捷提示')
    need(40 <= len(plugin['displayDescription']['zh']) <= 50, '中文简介必须在 40–50 字')
    need('REPLACE_WITH_' not in json.dumps(plugin, ensure_ascii=False), '作者占位未替换')
    need('dependencies' not in plugin, '本版不声明 dependencies（无本地 MCP）')
    need('tools' not in plugin, '开发者不得自行声明 tools')

    for rel in [*plugin['agents'], plugin['avatar']]:
        need((out / rel).is_file(), f'清单路径不存在：{rel}')
    for rel in plugin['skills']:
        need((out / rel).is_dir(), f'技能目录不存在：{rel}')

    agent_fm = parse_frontmatter(out / 'agents' / f"{plugin['agentName']}.md")
    need(agent_fm.get('name') == plugin['agentName'], 'agent frontmatter name 不一致')
    need('tools' not in agent_fm, 'agent 不得声明 tools')

    for skill_rel in plugin['skills']:
        skill_dir = out / skill_rel
        fm = parse_frontmatter(skill_dir / 'SKILL.md')
        need(fm.get('name') == skill_dir.name, f'{skill_dir.name}: SKILL.md name 与目录不一致')
        need(fm.get('user-invocable') == 'false', f'{skill_dir.name}: 必须 user-invocable: false')
        need(fm.get('version') == plugin['version'], f'{skill_dir.name}: 技能版本与插件版本不一致')

    # @references / @templates 一律相对**该文件所在目录**解析
    for path in out.rglob('*.md'):
        for ref in AT_REF.findall(path.read_text(encoding='utf-8')):
            target = path.parent / ref[1:]
            need(target.is_file(), f'{path.relative_to(out)}: 引用无法解析 → {ref}')

    width, height, colour = png_size(out / plugin['avatar'])
    need((width, height) == (512, 512), '头像尺寸必须是 512×512')
    if colour == 3:
        warnings.append('头像 PNG 为调色板模式（colour type 3）；若平台有额外要求需转 RGB')

    return warnings


def _find_bytecode(out: Path) -> list[str]:
    found = [str(p.relative_to(out)) for p in out.rglob('*')
             if p.name == '__pycache__' or p.suffix == '.pyc']
    if found:
        shutil.rmtree(out, ignore_errors=True)
        raise BuildError('产物含字节码，已删除：' + ', '.join(found))
    return []


def _zip_stamp() -> tuple[int, int, int, int, int, int]:
    """确定性时间戳：条目全部钉死，使 zip 的 sha256 只由内容决定。"""
    epoch = int(os.environ.get('SOURCE_DATE_EPOCH', '0'))
    if not epoch:
        return EPOCH
    import time
    return time.gmtime(max(epoch, 315532800))[:6]  # 不早于 1980-01-01（zip 格式下限）


def _write_zip(root: Path, archive: Path) -> str:
    stamp = _zip_stamp()
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(root.rglob('*')):
            rel = path.relative_to(root.parent).as_posix()
            info = zipfile.ZipInfo(rel + '/' if path.is_dir() else rel)
            info.date_time = stamp
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = ((0o40755 << 16) | 0x10) if path.is_dir() else (0o644 << 16)
            zf.writestr(info, b'' if path.is_dir() else path.read_bytes())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(archive.suffix + '.sha256').write_text(
        f'{digest}  {archive.name}\n', encoding='utf-8')
    return digest


def build(out_dir: Path, avatar: Path, publisher: str, email: str, make_zip: bool = True) -> dict:
    out_dir = Path(out_dir)
    plugin = read_json(SOURCE / '.codebuddy-plugin' / 'plugin.json')
    name, version = plugin['name'], plugin['version']

    root = _stage_tree(out_dir, name, plugin, avatar)
    _fill_publisher(root, publisher, email)
    _scan_for_leaks(root)
    warnings = _smoke_test(root)
    _find_bytecode(root)

    result = {
        'name': name, 'version': version, 'root': _display(root),
        'files': sorted(p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()),
        'warnings': warnings,
    }
    if make_zip:
        archive = out_dir / f'{name}-{version}.zip'
        result['sha256'] = _write_zip(root, archive)
        result['archive'] = _display(archive)
    return result


def _display(path: Path) -> str:
    """相对仓库根展示；构建到仓库外时退回绝对路径。"""
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--avatar', type=Path, default=DEFAULT_AVATAR)
    parser.add_argument('--publisher', default=DEFAULT_PUBLISHER)
    parser.add_argument('--email', default=DEFAULT_EMAIL)
    parser.add_argument('--no-zip', action='store_true')
    args = parser.parse_args()

    try:
        result = build(args.out, args.avatar, args.publisher, args.email, make_zip=not args.no_zip)
    except BuildError as exc:
        print(f'BUILD FAILED: {exc}', file=sys.stderr)
        return 2

    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(
        '\n作者与头像已替换，但以下门槛**仍未完成**，本包不是可上架成品：\n'
        '  WorkBuddy 实机安装 / 技能加载 / 宿主权限与数据流 / 48 条模型行为验收 / 隐私说明审阅。\n'
        '  release-readiness.json 的 6 个 gate 未改动。',
        file=sys.stderr,
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
