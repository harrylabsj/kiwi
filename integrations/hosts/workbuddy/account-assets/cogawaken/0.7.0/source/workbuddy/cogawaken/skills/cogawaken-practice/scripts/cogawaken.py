#!/usr/bin/env python3
"""Explicit-path, offline practice records. Python 3.9+, standard library only."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import uuid
from reflection import (FlowError, apply_turn, new_session, session_markdown,
                        validate_session)

STAGES = ('pause', 'describe', 'notice', 'explore', 'experiment', 'review')
MAX_BYTES = 1024 * 1024
FIELDS = {'goal', 'stage', 'observations', 'interpretations', 'feelings',
          'unknowns', 'experiment', 'feedback', 'next_step'}


class Invalid(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def fail(code, message):
    raise Invalid(code, message)


def text(value, field, nonempty=False):
    if not isinstance(value, str) or len(value) > 12000 or (nonempty and not value.strip()):
        fail('invalid_input', field + ' 必须是长度不超过 12000 的文本。')


def strings(value, field):
    if not isinstance(value, list) or len(value) > 100:
        fail('invalid_input', field + ' 必须是最多 100 项的列表。')
    for item in value:
        text(item, field)


def validate(data, legacy_read=False):
    if not isinstance(data, dict) or set(data) != FIELDS:
        fail('invalid_input', '记录字段不完整或含未知字段，请使用随包 record.json 模板。')
    text(data['goal'], 'goal', True)
    text(data['next_step'], 'next_step')
    if data['stage'] not in STAGES:
        fail('invalid_input', 'stage 必须为 ' + ', '.join(STAGES))
    for field in ('feelings', 'unknowns', 'feedback'):
        strings(data[field], field)
    specs = [('observations', 'source', ('user_report', 'provided_material')),
             ('interpretations', 'status', ('user_stated', 'coach_hypothesis', 'user_confirmed', 'rejected'))]
    for field, key, values in specs:
        if not isinstance(data[field], list) or len(data[field]) > 100:
            fail('invalid_input', field + ' 必须是最多 100 项的列表。')
        for item in data[field]:
            if not isinstance(item, dict) or set(item) != {'text', key}:
                fail('invalid_input', field + ' 条目字段不正确。')
            text(item['text'], field, True)
            if item[key] not in values:
                fail('invalid_input', field + ' 来源或状态不正确。')
            if key == 'status' and item[key] == 'user_confirmed' and not legacy_read:
                fail('ambiguous_confirmation', '新版禁止无依据的 user_confirmed 标记。请使用 v2 逐轮会话，分别记录转述确认与实验反馈；旧记录仍可读取导出。')
    exp = data['experiment']
    if exp is not None:
        if not isinstance(exp, dict) or set(exp) != {'hypothesis', 'action', 'observe', 'stop_condition', 'review_at'}:
            fail('invalid_input', 'experiment 字段不正确；没有实验时使用 null。')
        for key, value in exp.items():
            text(value, 'experiment.' + key, key != 'review_at')
    if len(json.dumps(data, ensure_ascii=False).encode('utf-8')) > MAX_BYTES:
        fail('invalid_input', '记录超过 1 MiB，请减少到本次必要摘要。')
    return data


def parse_json(raw):
    if len(raw) > MAX_BYTES:
        fail('invalid_input', '输入超过 1 MiB。')
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        fail('invalid_json', '输入不是有效 UTF-8 JSON。')


def input_json(path):
    if path == '-':
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    else:
        with open(path, 'rb') as handle:
            raw = handle.read(MAX_BYTES + 1)
    return parse_json(raw)


def input_data(path):
    return validate(input_json(path))


def record_root(directory, create=False):
    root = Path(directory).expanduser()
    if root.is_symlink():
        fail('unsafe_path', '记录目录不能是符号链接。')
    if create:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not root.is_dir():
        fail('missing_directory', '指定记录目录不存在。')
    return root.resolve()


def record_path(root, rid):
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', rid):
        fail('invalid_id', '请使用 create 返回的记录 ID。')
    return root / (rid + '.json')


def read_record(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        fail('not_found', '指定记录不存在。')
    with os.fdopen(fd, 'rb') as handle:
        record = parse_json(handle.read(MAX_BYTES + 1))
    if not isinstance(record, dict) or set(record) != {'schema_version', 'id', 'revision', 'created_at', 'updated_at', 'content'}:
        fail('invalid_record', '记录格式损坏，请核对来源或从用户持有的副本恢复。')
    if record['schema_version'] != 1 or record['id'] != path.stem or type(record['revision']) is not int or record['revision'] < 1:
        fail('invalid_record', '记录身份、格式版本或修订版本不匹配。')
    for key in ('created_at', 'updated_at'):
        text(record[key], key, True)
    validate(record['content'], legacy_read=True)
    return record


@contextmanager
def write_lock(root):
    fd = os.open(root / '.cogawaken.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def write_record(path, record):
    raw = json.dumps(record, ensure_ascii=False, indent=2).encode('utf-8')
    if len(raw) > MAX_BYTES:
        fail('invalid_input', '完整记录超过 1 MiB。')
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.record-', suffix='.tmp', delete=False) as handle:
            tmp = Path(handle.name)
            os.fchmod(handle.fileno(), 0o600)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if tmp is not None and tmp.exists():
            tmp.unlink()


def markdown(record):
    # Prefix every user-supplied line as a blockquote; never render active HTML.
    import html
    def quote(value):
        return '\n'.join('> ' + html.escape(line, quote=False) for line in value.split('\n'))
    c = record['content']
    lines = ['# 认知练习记录', '', '记录 ID：' + record['id'], '版本：' + str(record['revision']),
             '', '## 本次目标', '', quote(c['goal'])]
    labels = {'user_report': '用户陈述', 'provided_material': '用户提供材料',
              'user_stated': '用户解释', 'coach_hypothesis': '教练待核对假设',
              'user_confirmed': '旧版确认标记，未验证确认依据', 'rejected': '已撤回'}
    for key, title, tag in [('observations', '事件线索', 'source'), ('interpretations', '解释与状态', 'status')]:
        lines += ['', '## ' + title, '']
        lines += [quote('[' + labels[item[tag]] + '] ' + item['text']) + '\n' for item in c[key]] or ['尚未提供。']
    for key, title in [('feelings', '用户报告的感受'), ('unknowns', '仍未知'), ('feedback', '实际反馈')]:
        lines += ['', '## ' + title, ''] + [quote(v) + '\n' for v in c[key]]
        if not c[key]:
            lines += ['尚未提供。']
    if c['experiment']:
        lines += ['', '## 小实验', '']
        for key, title in [('hypothesis', '假设'), ('action', '行动'), ('observe', '观察项'), ('stop_condition', '停止条件'), ('review_at', '复盘时间')]:
            lines += [title + '：', quote(c['experiment'][key] or '未约定'), '']
    lines += ['', '## 下一步', '', quote(c['next_step'] or '未决定'), '']
    return '\n'.join(lines)


def parser():
    p = argparse.ArgumentParser(description='cogawaken 本地练习记录工具；只操作明确指定的目录，无联网功能。')
    subs = p.add_subparsers(dest='command', required=True)
    m = subs.add_parser('methods', help='读取随包方法卡，不读取个人记录')
    m.add_argument('--stage', choices=STAGES)
    m.add_argument('--need', help='按索引中的 need 筛选，不进行心理诊断或语义评分')
    m.add_argument('--id', help='仅读取指定方法卡')
    subs.add_parser('method-index', help='读取紧凑方法索引，减少不必要的上下文')
    entry = subs.add_parser('entry-index', help='先查看十个入口，再按入口读取少量候选')
    entry.add_argument('--id', help='读取一个入口的候选索引；不自动选择具体方法')
    ephemeral = subs.add_parser('turn-check', help='检查一轮模型提案并返回新状态，不写文件')
    ephemeral.add_argument('--input', required=True, help='包含 state 与 turn 的 JSON；- 表示标准输入')
    session_new = subs.add_parser('session-new', help='创建 v2 状态；不提供目录时只返回状态')
    session_new.add_argument('--directory')
    session_new.add_argument('--confirmed', action='store_true')
    for command in ('session-turn', 'session-read', 'session-export', 'session-delete'):
        cmd = subs.add_parser(command)
        cmd.add_argument('--directory', required=True)
        cmd.add_argument('--id', required=True)
        if command in ('session-turn', 'session-delete'):
            cmd.add_argument('--confirmed', action='store_true')
        if command == 'session-turn':
            cmd.add_argument('--input', required=True)
            cmd.add_argument('--expected-revision', required=True, type=int)
    for command in ('validate', 'create', 'read', 'update', 'export', 'delete'):
        cmd = subs.add_parser(command)
        if command in ('validate', 'create', 'update'):
            cmd.add_argument('--input', required=True, help='JSON 文件路径，或 - 表示标准输入')
        if command != 'validate':
            cmd.add_argument('--directory', required=True, help='用户明确指定的记录目录')
        if command in ('read', 'update', 'export', 'delete'):
            cmd.add_argument('--id', required=True)
        if command in ('create', 'update', 'delete'):
            cmd.add_argument('--confirmed', action='store_true', help='仅当用户已明确授权本操作时使用')
        if command == 'update':
            cmd.add_argument('--expected-revision', required=True, type=int)
    return p


def session_path(root, sid):
    validated = record_path(root, sid)
    return root / ('session-' + validated.name)


def read_session(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        fail('not_found', '指定逐轮会话不存在。')
    with os.fdopen(fd, 'rb') as handle:
        state = parse_json(handle.read(MAX_BYTES + 1))
    if not isinstance(state, dict) or path.name != 'session-' + str(state.get('id', '')) + '.json':
        fail('invalid_session', '会话 ID 与文件名不一致。')
    return validate_session(state)


def run_session(args):
    if args.command == 'turn-check':
        data = input_json(args.input)
        if not isinstance(data, dict) or set(data) != {'state', 'turn'}:
            fail('invalid_input', '需要 state 与 turn。')
        state = apply_turn(data['state'], data['turn'])
        return {'status': 'checked', 'semantic_verified': False, 'state': state,
                'reply_text': state['history'][-1]['reply_text']}
    mutating = args.command in ('session-turn', 'session-delete') or (args.command == 'session-new' and args.directory)
    if mutating and not args.confirmed:
        fail('confirmation_required', '未确认本地记录操作，不会写入或删除。')
    if args.command == 'session-new':
        state = new_session()
        if args.directory:
            root = record_root(args.directory, create=True)
            with write_lock(root):
                path = session_path(root, state['id'])
                if path.exists() or path.is_symlink():
                    fail('id_conflict', '会话 ID 冲突，请重试。')
                write_record(path, state)
        return {'status': 'ready', 'persisted': bool(args.directory), 'state': state}
    root = record_root(args.directory)
    path = session_path(root, args.id)
    if args.command in ('session-read', 'session-export'):
        state = read_session(path)
        return session_markdown(state) if args.command == 'session-export' else {'status': 'ok', 'state': state}
    request = input_json(args.input) if args.command == 'session-turn' else None
    with write_lock(root):
        state = read_session(path)
        if args.command == 'session-delete':
            path.unlink()
            return {'status': 'deleted', 'id': args.id, 'scope': '逐轮状态、方法快照和引用原文均在该文件中；外部副本未处理'}
        if args.expected_revision != state['revision']:
            fail('version_conflict', '会话版本已改变，请读取后协调，不会覆盖。')
        next_state = apply_turn(state, request)
        write_record(path, next_state)
        return {'status': 'saved', 'id': args.id, 'revision': next_state['revision'],
                'trace': next_state['history'][-1], 'reply_text': next_state['history'][-1]['reply_text'],
                'semantic_verified': False}


def run(args):
    if args.command == 'entry-index':
        index = json.loads((Path(__file__).resolve().parent.parent / 'references/entry-index.json').read_text())
        if args.id:
            index['entries'] = [e for e in index['entries'] if e['id'] == args.id]
        else:
            index['entries'] = [{k: v for k, v in e.items() if k != 'methods'} for e in index['entries']]
        return {'status': 'ok' if index['entries'] else 'no_match', 'index': index}
    if args.command.startswith('session-') or args.command == 'turn-check':
        return run_session(args)
    if args.command == 'method-index':
        index = json.loads((Path(__file__).resolve().parent.parent / 'references/method-index.json').read_text())
        return {'status': 'ok', 'index': index}
    if args.command == 'methods':
        cards = json.loads((Path(__file__).resolve().parent.parent / 'references/methods.json').read_text())
        matches = [c for c in cards if (not args.stage or args.stage in c['stages']) and
                   (not args.need or args.need == c.get('need')) and (not args.id or args.id == c['id'])]
        return {'status': 'ok' if matches else 'no_match', 'methods': matches,
                'selection': 'exact_filter_not_semantic_diagnosis'}
    if args.command in ('create', 'update', 'delete') and not args.confirmed:
        fail('confirmation_required', '尚未确认操作；先核对用户意图和具体内容，不会写入或删除。')
    data = input_data(args.input) if args.command in ('validate', 'create', 'update') else None
    if args.command == 'validate':
        return {'status': 'structurally_valid', 'semantic_verified': False,
                'scope': '只检查格式；不证明解释真实、用户确认或因果成立。'}
    root = record_root(args.directory, create=args.command == 'create')
    if args.command in ('read', 'export'):
        record = read_record(record_path(root, args.id))
        return markdown(record) if args.command == 'export' else {'status': 'ok', 'record': record}
    with write_lock(root):
        now = datetime.now(timezone.utc).isoformat()
        if args.command == 'create':
            rid = str(uuid.uuid4())
            path = record_path(root, rid)
            if path.exists():
                fail('id_conflict', '记录 ID 冲突，请重试创建。')
            record = {'schema_version': 1, 'id': rid, 'revision': 1, 'created_at': now, 'updated_at': now, 'content': data}
        else:
            path = record_path(root, args.id)
            record = read_record(path)
            if args.command == 'delete':
                path.unlink()
                return {'status': 'deleted', 'id': args.id, 'scope': '仅指定记录；草稿与导出副本未处理'}
            if args.expected_revision != record['revision']:
                fail('version_conflict', '版本已改变，请重新读取并协调修改，不会覆盖。')
            record.update(content=data, revision=record['revision'] + 1, updated_at=now)
        write_record(path, record)
        return {'status': 'saved', 'id': record['id'], 'revision': record['revision'], 'path': str(path)}


def main():
    try:
        result = run(parser().parse_args())
        print(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))
        return 0
    except Invalid as exc:
        print(json.dumps({'status': 'error', 'code': exc.code, 'message': str(exc)}, ensure_ascii=False))
        return 2
    except FlowError as exc:
        print(json.dumps({'status': 'needs_revision', 'code': exc.code, 'message': str(exc),
                          'persisted': False, 'semantic_verified': False}, ensure_ascii=False))
        return 2
    except (OSError, UnicodeError) as exc:
        print(json.dumps({'status': 'error', 'code': 'file_error', 'message': '文件或权限操作失败，未报告成功；请检查指定路径。', 'error_type': type(exc).__name__}, ensure_ascii=False))
        return 3


if __name__ == '__main__':
    sys.exit(main())
