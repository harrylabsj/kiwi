"""Replayable coaching state and structural checks; no model or network calls.

All utterances originate with the caller. Replay verifies internal consistency,
not that the host captured a real person, nor that a hypothesis is true.
"""
import copy
import hashlib
import json
from pathlib import Path
import re
import uuid

VERSION = '0.7.0'
STAGES = ('pause', 'describe', 'notice', 'explore', 'experiment', 'review')
MODES = ('explore', 'advice', 'summary', 'stop')
TRANSITIONS = {
    'pause': {'pause', 'describe'},
    'describe': {'pause', 'describe', 'notice', 'explore'},
    'notice': {'pause', 'describe', 'notice', 'explore'},
    'explore': {'pause', 'describe', 'notice', 'explore', 'experiment'},
    'experiment': {'pause', 'describe', 'explore', 'experiment', 'review'},
    'review': set(STAGES),
}
MAX_TURNS = 100


class FlowError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def require(ok, code, message):
    if not ok:
        raise FlowError(code, message)


def string(value, field, allow_empty=False, limit=12000):
    require(isinstance(value, str) and len(value) <= limit and (allow_empty or bool(value.strip())),
            'invalid_input', field + ' 必须是合法文本。')


def shape(value, required, optional=()):
    require(isinstance(value, dict) and set(required) <= set(value) <= set(required) | set(optional),
            'invalid_input', '字段缺少或不受支持：' + ', '.join(required))


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def catalog():
    path = Path(__file__).resolve().parent.parent / 'references/methods.json'
    raw = path.read_bytes()
    cards = json.loads(raw)
    return {'source': 'references/methods.json', 'file_sha256': hashlib.sha256(raw).hexdigest(),
            'cards_sha256': digest(cards), 'cards': cards}


def new_session(session_id=None, methods=None):
    return {'schema_version': 2, 'id': session_id or str(uuid.uuid4()), 'revision': 0,
            'catalog': copy.deepcopy(methods or catalog()), 'goal': '', 'stage': 'pause',
            'mode': 'explore', 'status': 'active', 'observations': [], 'hypotheses': [],
            'experiment': None, 'pending_confirmation': None, 'no_progress_turns': 0,
            'history': []}


def normalized(text):
    return text.strip().strip('。！!？?，, ').lower()


def control(text):
    commands = {'停一下': 'stop', '先到这里': 'stop', '先到这里，不想继续了': 'stop',
                '停止': 'stop', '/stop': 'stop', '直接给建议': 'advice',
                '直接给建议，不要再问': 'advice', '/advice': 'advice',
                '帮我整理': 'summary', '先整理给我看，暂时不要保存': 'summary', '/summary': 'summary'}
    return commands.get(normalized(text))


def affirmative(text):
    return normalized(text) in {'是', '是的', '对', '准确', '就是这样', '是这个意思',
                                '你的转述准确', '我确认这个转述', '可以', '愿意', '同意'}


def quote_ref(ref, utterances, current_id=None):
    shape(ref, {'turn_id', 'quote'})
    string(ref['quote'], 'quote')
    require(isinstance(ref['turn_id'], str) and ref['turn_id'] in utterances,
            'unknown_reference', '引用必须指向已有用户发言。')
    require(ref['quote'] in utterances[ref['turn_id']], 'quote_mismatch', '引用原文未在指定用户发言中出现。')
    if current_id is not None:
        require(ref['turn_id'] == current_id, 'stale_reference', '确认、撤回和反馈必须引用当前用户发言。')
    return copy.deepcopy(ref)


def _step(previous, request):
    shape(request, {'turn_id', 'user_text', 'plan'})
    string(request['turn_id'], 'turn_id', limit=80)
    require(bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', request['turn_id'])), 'invalid_id', 'turn_id 仅使用字母、数字、连字符或下划线。')
    string(request['user_text'], 'user_text')
    state = copy.deepcopy(previous)
    history = state['history']
    require(len(history) < MAX_TURNS, 'turn_limit', '请整理当前会话；单份逐轮记录最多 100 轮。')
    utterances = {h['request']['turn_id']: h['request']['user_text'] for h in history}
    require(request['turn_id'] not in utterances, 'duplicate_turn', '该 turn_id 已处理；请读取已有结果，不要重复追加。')
    utterances[request['turn_id']] = request['user_text']
    plan = request['plan']
    shape(plan, {'mode', 'stage', 'reason', 'method', 'reply'},
          {'goal', 'observations', 'events', 'experiment', 'ask_confirmation', 'resume', 'model'})
    require(plan['mode'] in MODES and plan['stage'] in STAGES, 'invalid_input', 'mode 或 stage 无效。')
    string(plan['reason'], 'reason', allow_empty=True, limit=500)
    shape(plan['reply'], {'reflection', 'question', 'advice', 'summary'})
    for key, value in plan['reply'].items():
        string(value, 'reply.' + key, allow_empty=True)
    if 'model' in plan:
        string(plan['model'], 'model', limit=150)
    required_mode = control(request['user_text'])
    if required_mode == 'stop' or plan['mode'] == 'stop':
        # A stop request succeeds even if the submitted model plan asks more questions.
        state.update(mode='stop', status='paused', pending_confirmation=None)
        reply_text = '好的，先到这里。'
        receipt = None
        checks = ['stop_overrides_plan']
        reply_origin = 'program'
    else:
        require(not required_mode or plan['mode'] == required_mode, 'mode_mismatch', '先响应用户明确的整理或建议要求。')
        if state['status'] == 'paused':
            require(plan.get('resume') is True and normalized(request['user_text']) in {'继续', '/resume', '继续刚才的练习'},
                    'resume_required', '会话已暂停；用户明确继续后再恢复。')
            state['status'] = 'active'
        shape(plan['reply'], {'reflection', 'question', 'advice', 'summary'})
        question = plan['reply']['question'].strip()
        require(sum(v.count('？') + v.count('?') for v in plan['reply'].values()) <= 1,
                'multiple_questions', '单轮只能有一个主要问句；这是标点检查，不能证明语义上只有一问。')
        if plan['mode'] in {'advice', 'summary'}:
            require(not question and not any('?' in v or '？' in v for v in plan['reply'].values()),
                    'question_in_direct_mode', '用户要求建议或整理时，此回复不继续追问。')
        else:
            require(plan['stage'] in TRANSITIONS[state['stage']], 'invalid_transition', '阶段跳转缺少前置环节。')
        progress = False
        if 'goal' in plan:
            shape(plan['goal'], {'text', 'source'})
            string(plan['goal']['text'], 'goal.text')
            quote_ref(plan['goal']['source'], utterances)
            progress = state['goal'] != plan['goal']['text']
            state['goal'] = plan['goal']['text']
        observations = plan.get('observations', [])
        require(isinstance(observations, list) and len(observations) <= 20, 'invalid_input', 'observations 必须为至多 20 项的列表。')
        for ref in observations:
            ref = quote_ref(ref, utterances)
            if not any(normalized(o['quote']) == normalized(ref['quote']) for o in state['observations']):
                state['observations'].append(ref)
                progress = True
        by_id = {h['id']: h for h in state['hypotheses']}
        events = plan.get('events', [])
        require(isinstance(events, list) and len(events) <= 20, 'invalid_input', 'events 必须为至多 20 项的列表。')
        pending = state['pending_confirmation']
        for event in events:
            shape(event, {'type', 'hypothesis_id', 'source'}, {'text', 'direction'})
            kind, hid = event['type'], event['hypothesis_id']
            string(hid, 'hypothesis_id', limit=80)
            require(bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', hid)), 'invalid_id', 'hypothesis_id 仅使用字母、数字、连字符或下划线。')
            ref = quote_ref(event['source'], utterances, None if kind == 'propose' else request['turn_id'])
            if kind == 'propose':
                require(hid not in by_id, 'duplicate_hypothesis', '假设 ID 已存在。')
                string(event.get('text'), 'hypothesis.text')
                require(len(by_id) < 30, 'hypothesis_limit', '单会话最多 30 个候选假设，请聚焦当前问题。')
                h = {'id': hid, 'text': event['text'], 'source': ref,
                     'formulation': {'status': 'unconfirmed', 'references': []},
                     'evidence': {'status': 'untested', 'reports': []}}
                state['hypotheses'].append(h)
                by_id[hid] = h
            else:
                require(hid in by_id, 'unknown_hypothesis', '未找到所引用的假设。')
                h = by_id[hid]
                if kind in {'confirm_formulation', 'accept_experiment'}:
                    scope = 'formulation' if kind == 'confirm_formulation' else 'experiment'
                    require(pending and pending['scope'] == scope and pending['hypothesis_id'] == hid,
                            'confirmation_not_requested', '前一轮没有请求对这个对象作这种确认。')
                    require(affirmative(request['user_text']), 'ambiguous_confirmation', '当前回答不是明确的简短确认；保留未确认，按原话继续澄清。')
                    if scope == 'formulation':
                        require(h['formulation']['status'] != 'rejected', 'retired_hypothesis', '已撤回假设不能用一个“是”复活；请建立新的候选。')
                        h['formulation'] = {'status': 'confirmed', 'references': [ref]}
                    else:
                        require(state['experiment'] and state['experiment']['hypothesis_id'] == hid,
                                'missing_experiment', '没有待确认的实验。')
                        state['experiment'].update(accepted=True, acceptance=ref)
                    pending = None
                elif kind == 'reject':
                    require(not affirmative(request['user_text']), 'contradictory_confirmation', '肯定答复不能作为撤回证据。')
                    h['formulation'] = {'status': 'rejected', 'references': [ref]}
                    if state['experiment'] and state['experiment']['hypothesis_id'] == hid:
                        state['experiment'] = None
                    pending = None
                elif kind == 'evidence':
                    exp = state['experiment']
                    require(h['formulation']['status'] != 'rejected', 'retired_hypothesis', '不能对已撤回假设追加支持结论。')
                    require(exp and exp['hypothesis_id'] == hid and exp['accepted'], 'feedback_without_experiment', '需要已接受的实验，才能在实验复盘中登记证据。')
                    require(exp['acceptance']['turn_id'] != request['turn_id'] and not affirmative(request['user_text']),
                            'confirmation_is_not_evidence', '接受实验或确认转述不等于报告实际结果。')
                    require(event.get('direction') in {'supports', 'challenges', 'inconclusive'}, 'invalid_input', '证据方向无效。')
                    report = {'source': ref, 'direction': event['direction'], 'assessment_origin': 'model_proposed'}
                    require(report not in h['evidence']['reports'], 'duplicate_evidence', '这条反馈已登记。')
                    h['evidence']['reports'].append(report)
                    directions = {v['direction'] for v in h['evidence']['reports']}
                    status = 'mixed' if {'supports', 'challenges'} <= directions else 'supported' if 'supports' in directions else 'challenged' if 'challenges' in directions else 'inconclusive'
                    h['evidence']['status'] = status
                else:
                    raise FlowError('unknown_event', '不支持的状态事件。')
            progress = True
        if 'experiment' in plan:
            exp = plan['experiment']
            shape(exp, {'hypothesis_id', 'action', 'observe', 'stop_condition', 'outcomes'})
            require(exp['hypothesis_id'] in by_id and by_id[exp['hypothesis_id']]['formulation']['status'] == 'confirmed',
                    'unconfirmed_formulation', '请先核对假设表述，再围绕它提出实验。')
            for k in ('action', 'observe', 'stop_condition'):
                string(exp[k], 'experiment.' + k)
            shape(exp['outcomes'], {'supports', 'challenges', 'inconclusive'})
            for value in exp['outcomes'].values():
                string(value, 'experiment.outcomes')
            state['experiment'] = dict(copy.deepcopy(exp), accepted=False, acceptance=None)
            progress = True
        stage = plan['stage'] if plan['mode'] == 'explore' else state['stage']
        if plan['mode'] == 'explore' and stage != 'pause':
            require(bool(state['goal']), 'missing_goal', '先明确本次目标；直接建议和停止不受此限制。')
        if stage in {'notice', 'explore', 'experiment', 'review'} and plan['mode'] == 'explore':
            require(bool(state['observations']), 'missing_observation', '先引用具体事件线索。')
        if stage in {'explore', 'experiment', 'review'} and plan['mode'] == 'explore':
            require(any(h['formulation']['status'] != 'rejected' for h in by_id.values()), 'missing_hypothesis', '需要明确的候选假设，或回到澄清阶段。')
        if stage == 'experiment' and plan['mode'] == 'explore':
            require(state['experiment'] is not None, 'missing_experiment', '实验阶段需有可检查的实验方案。')
        if stage == 'review' and plan['mode'] == 'explore':
            require(state['experiment'] and state['experiment']['accepted'] and any(e['type'] == 'evidence' for e in events),
                    'missing_feedback', '复盘需要已接受的实验和当前实际反馈。')
        receipt = None
        if plan['method'] is not None:
            shape(plan['method'], {'id', 'branch'})
            card = next((c for c in state['catalog']['cards'] if c['id'] == plan['method']['id']), None)
            require(card is not None, 'unknown_method', '方法卡不存在。')
            branch = next((b for b in card['branches'] if b['id'] == plan['method']['branch']), None)
            require(branch is not None, 'unknown_branch', '方法分支不存在。')
            benefit_summary = card['id'] == 'goal-clarify' and branch['id'] == 'benefit-summary'
            if benefit_summary:
                require(plan['mode'] == 'summary', 'branch_control_mismatch', '思考收益检查用于整理，不开启新一轮追问。')
            require(benefit_summary or stage in card['stages'], 'method_stage_mismatch', '方法卡不适用于所选阶段。')
            require(branch['id'] != 'stop', 'branch_control_mismatch', '停止分支应使用 stop 模式，不继续生成探索回复。')
            if branch['id'] == 'not-done':
                require(not any(e['type'] == 'evidence' for e in events), 'non_observation_feedback', '未实施实验不能登记为支持或反对假设的证据。')
            receipt = {'id': card['id'], 'version': card['version'], 'card_sha256': digest(card),
                       'branch': branch['id'], 'branch_sha256': digest(branch),
                       'catalog_file_sha256': state['catalog']['file_sha256'],
                       'origin': 'program_read_of_session_catalog', 'selection_origin': 'model_proposed',
                       'semantic_fit_verified': False}
            # Conditional fields preserve replay of pre-0.3 snapshots unchanged.
            if 'attribution' in card.get('source', {}):
                receipt['attribution'] = card['source']['attribution']
                receipt['source_kind'] = card['source']['kind']
        elif plan['mode'] == 'explore':
            require(bool(plan['reason'].strip()), 'missing_reason', '未选择卡片时须简述通用澄清或收束的依据。')
        ask = plan.get('ask_confirmation')
        if ask is not None:
            shape(ask, {'scope', 'hypothesis_id'})
            require(ask['scope'] in {'formulation', 'experiment'} and ask['hypothesis_id'] in by_id and bool(question),
                    'invalid_confirmation_request', '确认需要指明唯一对象与范围，并提出一个问题。')
            require(by_id[ask['hypothesis_id']]['formulation']['status'] != 'rejected', 'retired_hypothesis', '不能要求重新确认已撤回假设。')
            if ask['scope'] == 'experiment':
                require(state['experiment'] and state['experiment']['hypothesis_id'] == ask['hypothesis_id'], 'missing_experiment', '需先提出实验。')
                target_text = state['experiment']['action']
            else:
                target_text = by_id[ask['hypothesis_id']]['text']
            require(target_text in '\n'.join(plan['reply'].values()), 'confirmation_target_not_shown', '确认对象的具体表述必须出现在本轮回复中，不能把无关的“是”关联到假设。')
            pending = dict(ask, turn_id=request['turn_id'], question=question)
        else:
            # A yes must answer the immediately preceding explicit confirmation.
            pending = None
        state['no_progress_turns'] = 0 if progress else state['no_progress_turns'] + 1
        require(not (state['no_progress_turns'] >= 2 and plan['mode'] == 'explore' and question),
                'needs_summary', '连续两轮没有记录到新的状态信息，请先整理；不要继续重复提问。')
        state.update(stage=stage, mode=plan['mode'], pending_confirmation=pending)
        reply_text = '\n\n'.join(plan['reply'][k].strip() for k in ('reflection', 'advice', 'summary', 'question') if plan['reply'][k].strip())
        require(bool(reply_text), 'empty_reply', '需要可呈现的回复。')
        checks = ['quoted_sources_exist', 'confirmation_scope', 'stage_prerequisites', 'method_and_branch', 'reply_structure']
        reply_origin = 'proposal_text'
    state['revision'] += 1
    entry = {'turn_id': request['turn_id'], 'request': copy.deepcopy(request), 'reply_text': reply_text,
             'reply_origin': reply_origin, 'method_receipt': receipt,
             'decision_summary': plan['reason'], 'model': plan.get('model', 'unreported'),
             'checks': checks, 'source_trust': 'caller_supplied_not_host_attested',
             'semantic_verified': False}
    entry['previous_sha256'] = history[-1]['entry_sha256'] if history else None
    entry['entry_sha256'] = digest(entry)
    history.append(entry)
    return state


def _validate_session(state):
    require(isinstance(state, dict) and state.get('schema_version') == 2, 'invalid_session', '需要 v2 会话状态。')
    require(isinstance(state.get('history'), list) and len(state['history']) <= MAX_TURNS,
            'invalid_session', '会话历史格式无效。')
    require(isinstance(state.get('id'), str) and re.fullmatch(r'[0-9a-f-]{36}', state['id']), 'invalid_session', '会话 ID 无效。')
    c = state.get('catalog', {})
    shape(c, {'source', 'file_sha256', 'cards_sha256', 'cards'})
    require(isinstance(c['cards'], list) and digest(c['cards']) == c['cards_sha256'], 'catalog_mismatch', '方法快照校验值不匹配。')
    replay = new_session(state['id'], c)
    for entry in state['history']:
        require(isinstance(entry, dict) and isinstance(entry.get('request'), dict), 'invalid_session', '逐轮记录缺少请求。')
        replay = _step(replay, entry['request'])
    require(replay == state, 'state_mismatch', '会话状态与逐轮事件重放不一致，不能直接改写确认状态或历史。')
    return state


def validate_session(state):
    try:
        return _validate_session(state)
    except (KeyError, TypeError, AttributeError, IndexError) as exc:
        raise FlowError('invalid_session', '会话或方法快照格式损坏，请使用有效状态；不会写入。') from exc


def apply_turn(state, request):
    validate_session(state)
    try:
        return _step(state, request)
    except (KeyError, TypeError, AttributeError, IndexError) as exc:
        raise FlowError('invalid_input', '逐轮提案包含无效的数据类型或结构，不会写入。') from exc


def session_markdown(state):
    import html
    validate_session(state)
    q = lambda value: '\n'.join('> ' + html.escape(line, quote=False) for line in value.splitlines()) + '\n'
    lines = ['# 认知练习逐轮记录', '', '转述确认与证据支持分开记录；引用来自调用方，未独立核实真实性。', '']
    for h in state['hypotheses']:
        lines += ['## 假设 ' + h['id'], q(h['text']),
                  '转述状态：' + h['formulation']['status'], '证据状态：' + h['evidence']['status'], '']
    for turn in state['history']:
        m = turn['method_receipt']
        lines += ['## 回合 ' + turn['turn_id'], '用户原话', q(turn['request']['user_text']),
                  '海纳', q(turn['reply_text']), '回答来源：' + turn['reply_origin'],
                  q('方法：' + (m['id'] + ' @ ' + m['version'] + ' / ' + m['branch'] if m else '通用流程／未选择方法卡')),
                  *([q('来源标注：' + m['attribution'])] if m and 'attribution' in m else []),
                  '简短依据', q(turn['decision_summary']), '校验：' + ', '.join(turn['checks']), '']
    return '\n'.join(lines)
