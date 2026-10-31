#!/usr/bin/env python3
"""Validate and package only the distributable WorkBuddy expert; stdlib only."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'workbuddy/cogawaken'


def check(package=PACKAGE):
    package = Path(package)
    errors = []
    try:
        m = json.loads((package / '.codebuddy-plugin/plugin.json').read_text())
        required = {'name','version','description','author','agents','expertType','agentName','displayName','profession','displayDescription','avatar','categoryId','defaultInitPrompt','plugin','tags','quickPrompts'}
        assert required <= m.keys(), '缺少必填字段'
        assert m['name'] == m['plugin'] == 'cogawaken'
        assert m['expertType'] == 'agent' and m['agentName'] == 'haina'
        assert re.fullmatch(r'\d+\.\d+\.\d+',m['version'])
        assert m['author']['name'] and re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',m['author']['email'])
        assert m['displayName']['zh'] == '海纳·认知专家'
        assert m['profession']['zh'] == '认知觉醒教练'
        for key in ('displayName','profession','displayDescription','defaultInitPrompt'):
            assert set(m[key]) == {'en','zh'} and all(isinstance(v,str) and v for v in m[key].values()), key
        assert 40 <= len(m['displayDescription']['zh']) <= 50, '中文介绍必须 40–50 字'
        assert len(m['tags']) == len(m['quickPrompts']) == 3
        assert m['defaultInitPrompt'] == m['quickPrompts'][0]
        assert 'dependencies' not in m, '基础包不得声明云端依赖'
        assert not (package/'.mcp.json').exists(), '基础包不得预置 MCP'
        refs = m['agents'] + m.get('skills',[]) + [m['avatar']]
        for ref in refs:
            p = package/ref
            assert p.resolve().is_relative_to(package.resolve()) and p.exists(), '无效资源路径 '+ref
        raw = (package/m['avatar']).read_bytes()
        assert raw[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II',raw[16:24]) == (512,512)
        assert len(raw) < 500*1024
        agent = (package/m['agents'][0]).read_text()
        assert agent.startswith('---\n') and agent.count('---\n') >= 2
        front = agent.split('---\n')[1]
        assert re.search(r'^name: haina$',front,re.M)
        assert not re.search(r'^(?:tools|allowed-tools):',front,re.M), '工具权限由宿主分配'
        for p in package.rglob('*.md'):
            content = p.read_text()
            assert content.count('```') % 2 == 0, '代码围栏不成对 '+str(p)
            for ref in re.findall(r'\]\(([^\s)]+)\)',content):
                if ':' in ref or ref.startswith('#'):
                    continue
                target=(p.parent/ref.split('#')[0]).resolve()
                assert target.is_relative_to(package.resolve()) and target.exists(), '断开的引用 '+ref
        skill = package/'skills/cogawaken-practice'
        f = (skill/'SKILL.md').read_text().split('---\n')[1]
        for key in ('name','description','description_zh','description_en','version','author'):
            assert re.search(r'^'+key+r': .+',f,re.M), '技能缺少 '+key
        cards = json.loads((skill/'references/methods.json').read_text())
        index = json.loads((skill/'references/method-index.json').read_text())
        ids = {c['id'] for c in cards}
        entries = json.loads((skill/'references/entry-index.json').read_text())
        assert entries['version'] == m['version']
        assert len(entries['entries']) == len({e['id'] for e in entries['entries']}) == 10
        routed = [v['id'] for e in entries['entries'] for v in e['methods']]
        shared = entries['shared_check']['method_id']
        assert len(routed) == len(set(routed)), '入口方法重复'
        assert shared not in routed and set(routed) | {shared} == ids, '入口覆盖不完整'
        for e in entries['entries']:
            assert e['title'] and e['use_when'] and 1 <= len(e['methods']) <= 4
            for v in e['methods']:
                original = next(c for c in cards if c['id'] == v['id'])
                assert all(v[k] == original[k] for k in ('title', 'use_when', 'stages')), '入口索引与卡片不一致'
        assert cards and len(ids) == len(cards), '方法卡 ID 必须唯一'
        assert index['version'] == m['version']
        assert len(index['methods']) == len(cards) and {c['id'] for c in index['methods']} == ids, '索引与方法卡不一致'
        for c in cards:
            assert all(c.get(k) for k in ('stages','use_when','question','avoid_when','stop_when','source','counterexample'))
            assert c['version'] == m['version']
            src = c['source']
            assert src['kind'] in {'note_adaptation', 'product_flow', 'ai_proposed'}
            assert src['adaptation']['novelty_claim'] is False and src['method_effectiveness'] == 'not_validated'
            if src['kind'] == 'note_adaptation':
                assert src['note_refs'] and src['attribution'] == '笔记改编：海纳认知专家'
                assert src['adaptation']['by'] == '海纳认知专家'
            else:
                assert src['attribution'].startswith('AI 补充设计')
            entry = next(v for v in index['methods'] if v['id'] == c['id'])
            assert entry['need'] == c['need'] and entry['stages'] == c['stages'] and entry['attribution'] == src['attribution']
            branches = c.get('branches', [])
            assert len({b['id'] for b in branches}) == len(branches)
            assert {'corrected', 'unknown', 'stop'} <= {b['id'] for b in branches}
            assert all(b.get('when') and b.get('action') and b.get('next_stage') for b in branches)
        for p in package.rglob('*'):
            assert not p.is_symlink(), '分发包不能包含符号链接'
    except (AssertionError, KeyError, ValueError, OSError, TypeError) as exc:
        errors.append(str(exc) or '配置约束不符合')
    return errors


def build(destination=None, package=PACKAGE):
    errors=check(package)
    if errors:
        raise ValueError('; '.join(errors))
    m=json.loads((package/'.codebuddy-plugin/plugin.json').read_text())
    out=Path(destination) if destination else ROOT/'dist'/('cogawaken-'+m['version']+'.zip')
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
        for p in sorted(package.rglob('*')):
            if not p.is_file() or '__pycache__' in p.parts or p.suffix=='.pyc' or p.name=='.DS_Store':
                continue
            info=zipfile.ZipInfo(str(Path('cogawaken')/p.relative_to(package)),date_time=(2026,1,1,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o100644 << 16
            archive.writestr(info,p.read_bytes())
    digest=hashlib.sha256(out.read_bytes()).hexdigest()
    out.with_suffix('.zip.sha256').write_text(digest+'  '+out.name+'\n')
    return out,digest


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--check',action='store_true')
    args=p.parse_args()
    errors=check()
    if errors:
        print(json.dumps({'status':'invalid','errors':errors},ensure_ascii=False))
        raise SystemExit(1)
    if args.check:
        print('WorkBuddy expert package static checks passed.')
    else:
        path,digest=build()
        print(json.dumps({'status':'built','path':str(path),'sha256':digest},ensure_ascii=False))
