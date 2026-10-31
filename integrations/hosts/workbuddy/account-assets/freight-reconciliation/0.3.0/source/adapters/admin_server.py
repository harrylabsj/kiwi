"""本地管理页（§19.1 五页面 + §17.1 确认路由）。

- 仅监听 127.0.0.1；独立会话 cookie + CSRF token + Origin/Host 检查。
- GET 无副作用；POST 才能确认；一次性确认凭证不进模型上下文。
- prepare/confirm 分离：这里是人类确认的唯一入口；MCP 模型层不可达。

页面：
  /                          案件首页（账期/主体/承运商/覆盖/版本，不给"节省金额"大字）
  /cases/{id}                案件详情（导入与映射页）
  /cases/{id}/issues         差异工作台（分区展示，不可比金额不混入差额榜）
  /cases/{id}/review/{run}/{group}  证据复核页（四栏：原账单/运输凭证/规则公式/决定）
  /cases/{id}/versions       版本与导出页（新旧差异、未解决项、导出确认）
  /admin/confirmations       待确认列表
  POST /admin/confirmations/{id}/confirm   确认路由（CSRF+会话+一次性凭证）
  POST /admin/cases/{id}/freeze            冻结确认
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

REPO_ROOT = Path(__file__).resolve().parents[1]
# 开发树布局才把 src/ 插进 sys.path；pip/uvx 安装后 freight_core 已可直接导入。
if (REPO_ROOT / "src" / "freight_core").is_dir():
    sys.path.insert(0, str(REPO_ROOT / "src"))

from freight_core.service import ReconciliationService  # noqa: E402
from freight_core.errors import FreightError  # noqa: E402

DEFAULT_ROOT = os.environ.get(
    "FREIGHT_RECON_ROOT",
    str(Path.home() / ".local" / "share" / "freight-reconciliation"))

_PAGE = """<!doctype html><html lang=zh><meta charset=utf-8>
<title>海纳·运费对账 — 管理页</title>
<style>
body{{font-family:-apple-system,sans-serif;margin:2em;color:#222}}
table{{border-collapse:collapse;margin:1em 0}}td,th{{border:1px solid #ccc;padding:4px 10px;font-size:14px}}
h1{{font-size:20px}}h2{{font-size:16px}} .warn{{color:#b00}} .ok{{color:#070}}
form{{display:inline}} button{{padding:4px 12px}} nav a{{margin-right:1em}}
.badge{{background:#eee;border-radius:4px;padding:2px 6px;font-size:12px}}
</style>
<nav><a href=/>案件首页</a><a href=/admin/confirmations>待确认</a></nav>
{body}"""

_FORM = """<form method=post action={action}><input type=hidden name=csrf value={csrf}>
<button {disabled}>{label}</button></form>"""


class AdminState:
    def __init__(self, root: str):
        self.service = ReconciliationService(root)
        self.sessions: dict[str, str] = {}  # cookie -> csrf
        self.password = os.environ.get("FREIGHT_ADMIN_TOKEN")
        if not self.password:
            raise RuntimeError("FREIGHT_ADMIN_TOKEN is required")


STATE: AdminState | None = None


def _rows_to_dicts(rows) -> list[dict]:
    return [dict(r) for r in rows]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 安静日志；不落整表/隐私（§20.2）
        sys.stderr.write("admin: " + fmt % args + "\n")

    # ------------------------------------------------------------- 基础
    def _session(self):
        cookies = self.headers.get("Cookie", "")
        token = None
        for part in cookies.split(";"):
            if part.strip().startswith("fsession="):
                token = part.split("=", 1)[1].strip()
        return token if token in STATE.sessions else None

    def _check_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True  # 同源表单（非浏览器客户端也走会话+CSRF）
        host = self.headers.get("Host", "")
        return origin.endswith(host) and ("127.0.0.1" in origin or "localhost" in origin)

    def _csrf_ok(self, form: dict) -> bool:
        session = self._session()
        return session is not None and form.get("csrf") == STATE.sessions[session]

    def _html(self, body: str, status: int = 200, headers: dict | None = None) -> None:
        data = _PAGE.format(body=body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Frame-Options", "DENY")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, location: str, headers: dict | None = None) -> None:
        self.send_response(303)
        self.send_header("Location", location)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def _form(self, action: str, label: str, disabled: bool = False) -> str:
        session = self._session()
        csrf = STATE.sessions.get(session, "")
        dis = "disabled" if disabled else ""
        return _FORM.format(action=action, csrf=csrf, label=label, disabled=dis)

    # ------------------------------------------------------------- GET
    def do_GET(self):
        if self._session() is None:
            return self._login_page()
        path = urlparse(self.path).path
        try:
            if path == "/":
                return self._page_home()
            m = path.split("/")
            if path == "/admin/confirmations":
                return self._page_confirmations()
            if len(m) == 3 and m[1] == "cases":
                return self._page_case(m[2])
            if len(m) == 4 and m[3] == "issues":
                return self._page_issues(m[2])
            if len(m) == 4 and m[3] == "versions":
                return self._page_versions(m[2])
            if len(m) == 6 and m[3] == "review":
                return self._page_review(m[2], m[4], m[5])
            return self._html("<h1>404</h1>", 404)
        except FreightError as exc:
            return self._html(f"<h1>错误</h1><p class=warn>{exc.message}</p>", 400)

    def _login_page(self, error: str = "") -> None:
        self._html(f"""<h1>海纳·运费对账 — 管理页登录</h1>
<form method=post action=/admin/login>本地访问口令: <input type=password name=token>
<input type=submit value=登录></form><p class=warn>{error}</p>
<p>独立会话；确认动作需会话+CSRF+一次性凭证（§17.2）。模型不可达本页。</p>""")

    def _page_home(self) -> None:
        cases = _rows_to_dicts(STATE.service.db.conn.execute(
            "SELECT * FROM cases ORDER BY created_at DESC").fetchall())
        rows = "".join(
            f"<tr><td><a href=/cases/{c['id']}>{c['title']}</a></td>"
            f"<td>{c['carrier_id']}</td><td>{c['period_from']}~{c['period_to']}</td>"
            f"<td><span class=badge>{c['status']}</span></td><td>rev {c['case_revision']}</td>"
            f"<td>{c['currency']}/{c['amount_basis']}</td></tr>" for c in cases)
        self._html(f"<h1>案件首页</h1><table><tr><th>案件</th><th>承运商</th><th>账期</th>"
                   f"<th>状态</th><th>版本</th><th>币种/口径</th></tr>{rows}</table>"
                   "<p>金额与覆盖以运行版本为准；本页不展示「节省金额」大字（§19.1）。</p>")

    def _page_case(self, case_id: str) -> None:
        svc = STATE.service
        case = svc.get_case(case_id)
        assets = _rows_to_dicts(svc.db.conn.execute(
            "SELECT * FROM assets WHERE case_id=?", (case_id,)).fetchall())
        rows = "".join(
            f"<tr><td>{a['id']}</td><td>{a['kind']}</td><td>{a['original_name']}</td>"
            f"<td>{a['detail_rows']}</td><td>{a['parse_error_rows']}</td>"
            f"<td>{'完整' if a['amount_complete'] else '<b class=warn>不完整</b>'}</td></tr>"
            for a in assets)
        latest = svc.db.conn.execute(
            "SELECT run_id, status FROM runs WHERE case_id=? ORDER BY created_at DESC"
            " LIMIT 1", (case_id,)).fetchone()
        run_link = (f"<a href=/cases/{case_id}/versions>run {latest['run_id']}"
                    f"（{latest['status']}）</a>") if latest else "尚无运行"
        self._html(f"""<h1>案件：{case['title']}</h1>
<p>{case['workspace_id']} / {case['carrier_id']} / {case['period_from']} ~ {case['period_to']}
/ {case['currency']} {case['amount_basis']} / <span class=badge>{case['status']}</span></p>
<p>最新运行：{run_link}</p>
<h2>导入与映射</h2>
<table><tr><th>asset</th><th>类型</th><th>文件名</th><th>明细行</th><th>失败行</th><th>金额完整性</th></tr>
{rows}</table>
<h2>差异工作台</h2><p><a href=/cases/{case_id}/issues>进入差异工作台 →</a></p>""")

    def _page_issues(self, case_id: str) -> None:
        svc = STATE.service
        run = svc.db.conn.execute(
            "SELECT * FROM runs WHERE case_id=? ORDER BY created_at DESC LIMIT 1",
            (case_id,)).fetchone()
        if run is None:
            return self._html("<h1>差异工作台</h1><p>尚无运行结果。</p>")
        summary = json.loads(run["summary"]) if run["summary"] else {}
        groups = _rows_to_dicts(svc.db.conn.execute(
            "SELECT g.*, r.comparison_status, r.evidence_status, r.delta_minor, r.issues,"
            " r.expected_minor, r.result_digest FROM charge_groups g JOIN results r"
            " ON r.run_id=g.run_id AND r.group_id=g.group_id WHERE g.run_id=?"
            " ORDER BY g.group_id", (run["run_id"],)).fetchall())
        amt_rows = "".join(
            f"<tr><td><a href=/cases/{case_id}/review/{run['run_id']}/{g['group_id']}>"
            f"{g['group_id']}</a></td><td>{g['trip_id'] or '—'}</td>"
            f"<td>{g['charge_code']}</td><td>{g['billed_minor']}</td>"
            f"<td>{g['expected_minor'] if g['expected_minor'] is not None else '未知'}</td>"
            f"<td class={'warn' if (g['delta_minor'] or 0) > 0 else ''}>{g['delta_minor'] if g['delta_minor'] is not None else '不可比'}</td>"
            f"<td>{g['issues']}</td></tr>"
            for g in sorted(groups, key=lambda g: -(g["delta_minor"] or 0))
            if g["delta_minor"] is not None and g["delta_minor"] != 0)
        nc_rows = "".join(
            f"<tr><td><a href=/cases/{case_id}/review/{run['run_id']}/{g['group_id']}>"
            f"{g['group_id']}</a></td><td>{g['match_state']}</td><td>{g['pod_state']}</td>"
            f"<td>{g['billed_minor']}</td><td>{g['issues']}</td></tr>"
            for g in groups if g["comparison_status"] != "COMPARABLE")
        case_issues = _rows_to_dicts(svc.db.conn.execute(
            "SELECT * FROM issues WHERE run_id=? AND group_id='__case__'",
            (run["run_id"],)).fetchall())
        ci_rows = "".join(f"<tr><td>{i['code']}</td><td>{i['message']}</td></tr>"
                          for i in case_issues)
        cov_den = summary.get("abs_total_billed_minor") or 0
        cov = (f"{summary.get('abs_comparable_billed_minor', 0) / cov_den:.2%}"
               if cov_den else "未知")
        self._html(f"""<h1>差异工作台 — run {run['run_id']}</h1>
<p>账单净额 {summary.get('source_signed_total_minor', 0)/100:.2f} 元 =
可比 {summary.get('comparable_billed_minor', 0)/100:.2f} + 不可比
{summary.get('unresolved_billed_minor', 0)/100:.2f} + 明确排除
{summary.get('out_of_scope_billed_minor', 0)/100:.2f}（守恒）
　正向差额 <b class=warn>{summary.get('positive_difference_minor', 0)/100:.2f}</b> 元，
反向 {summary.get('negative_difference_minor', 0)/100:.2f} 元，
净 {summary.get('net_difference_minor', 0)/100:.2f} 元，金额覆盖 {cov}</p>
<p>金额完整性：{'<span class=ok>完整</span>' if run['amount_complete'] else '<b class=warn>不完整：不能正式冻结</b>'}</p>
<h2>待核金额差异（可比组，按差额排序）</h2>
<table><tr><th>组</th><th>trip</th><th>费用</th><th>账单净额(分)</th><th>应计(分)</th><th>差额(分)</th><th>异常</th></tr>{amt_rows}</table>
<h2>不可比 / 缺证 / 待匹配</h2>
<table><tr><th>组</th><th>匹配</th><th>凭证</th><th>账单净额(分)</th><th>异常</th></tr>{nc_rows}</table>
<h2>案件级提示</h2><table><tr><th>码</th><th>说明</th></tr>{ci_rows}</table>""")

    def _page_review(self, case_id: str, run_id: str, group_id: str) -> None:
        svc = STATE.service
        ev = svc.freight_get_evidence(run_id, group_id)
        result = ev["result"] or {}
        lines = "".join(
            f"<tr><td>{l['line_id']}</td><td>{l['amount_minor']}</td>"
            f"<td>{l['reversal_of'] or ''}</td>"
            f"<td>{l['locator']['asset_id']} 第{l['locator']['row']}行</td></tr>"
            for l in ev["bill_lines"])
        trip = ev["trip"] or {}
        decision = ev.get("decision") or {}
        decision_forms = ""
        for d, lbl in [("CONFIRMED_DIFFERENCE", "确认为差异"),
                       ("ACCEPTED_AS_BILLED", "接受账单原额（保留差异记录）"),
                       ("NEEDS_EVIDENCE", "待补证"), ("DISPUTED", "争议中")]:
            decision_forms += (f"<form method=post action=/admin/confirm-review/"
                               f"{case_id}/{run_id}/{group_id}>"
                               f"<input type=hidden name=csrf value={STATE.sessions.get(self._session(), '')}>"
                               f"<input type=hidden name=decision value={d}>"
                               f"理由: <input name=reason size=40> "
                               f"<button>{lbl}</button></form>")
        self._html(f"""<h1>证据复核 — {group_id}</h1>
<table style=width:100%><tr>
<td style=vertical-align:top width=33%><h2>原账单</h2><table>
<tr><th>行</th><th>金额(分)</th><th>冲销指向</th><th>定位</th></tr>{lines}</table></td>
<td style=vertical-align:top width=33%><h2>运输/凭证</h2>
<p>{trip.get('trip_id','无关联运输')} {trip.get('route_id','')} {trip.get('vehicle_class','')}<br>
出发：{trip.get('departed_at','—')}　状态：{trip.get('execution_status','—')}</p>
<p>凭证状态：{ev['group']['pod_state']}；事件：{json.dumps(ev['group']['event'], ensure_ascii=False)}</p></td>
<td style=vertical-align:top width=33%><h2>规则与公式</h2>
<p>规则：{result.get('rule_ref') or '未适用'}<br>轨迹：{'<br>'.join(result.get('trace') or [])}</p>
<p>账单净额 {result.get('billed_minor')} / 应计 {result.get('expected_minor') if result.get('expected_minor') is not None else '未知'}
/ 差额 {result.get('delta_minor') if result.get('delta_minor') is not None else '不可比'}</p></td></tr></table>
<h2>处理决定</h2>
<p>结果摘要 <code>{result.get('result_digest','')[:24]}…</code>
　当前决定：{decision.get('decision') or '无'}（{decision.get('status') or '—'}）</p>
{decision_forms}
<p class=warn>决定不改写计算值；接受账单会保留原始差异与理由（§12.2）。</p>""")

    def _page_versions(self, case_id: str) -> None:
        svc = STATE.service
        runs = _rows_to_dicts(svc.db.conn.execute(
            "SELECT * FROM runs WHERE case_id=? ORDER BY created_at", (case_id,)).fetchall())
        rows = "".join(
            f"<tr><td>{r['run_id']}</td><td>{r['status']}</td><td>{r['supersedes_run_id'] or '—'}</td>"
            f"<td>{json.loads(r['summary']).get('net_difference_minor') if r['summary'] else '—'}</td>"
            f"<td>{'完整' if r['amount_complete'] else '<b class=warn>不完整</b>'}</td></tr>"
            for r in runs)
        latest = runs[-1] if runs else None
        freeze = ""
        export = ""
        if latest is not None:
            case = svc.get_case(case_id)
            can_freeze = latest["amount_complete"] == 1 and case["status"] != "FROZEN"
            freeze = self._form(f"/admin/cases/{case_id}/freeze?run={latest['run_id']}",
                                "冻结当前运行", disabled=not can_freeze)
            export = self._form(f"/admin/cases/{case_id}/prepare-export?run={latest['run_id']}",
                                "准备导出")
        exports = _rows_to_dicts(svc.db.conn.execute(
            "SELECT * FROM exports WHERE case_id=? ORDER BY created_at DESC",
            (case_id,)).fetchall())
        ex_rows = ""
        for e in exports:
            links = " ".join(
                f"<a href=/download/{e['export_id']}/{a['name']}>{a['name']}</a>"
                for a in json.loads(e["artifacts"]))
            ex_rows += (f"<tr><td>{e['export_id']}</td><td>{e['status']}</td>"
                        f"<td>{e['purpose']}</td><td>{e['unresolved_group_count']}</td>"
                        f"<td>{links}</td></tr>")
        self._html(f"""<h1>版本与导出</h1>
<table><tr><th>run</th><th>状态</th><th>替代</th><th>净差额(分)</th><th>金额完整性</th></tr>{rows}</table>
<p>{freeze} {export}</p>
<h2>导出记录</h2><table><tr><th>导出</th><th>状态</th><th>用途</th><th>未解决组</th><th>文件</th></tr>{ex_rows}</table>
<p class=warn>导出是核对材料，不是付款指令；对外发送由人执行（§12.1 H）。</p>""")

    def _page_confirmations(self) -> None:
        reqs = _rows_to_dicts(STATE.service.db.conn.execute(
            "SELECT * FROM confirmation_requests WHERE status='PENDING'"
            " ORDER BY created_at DESC").fetchall())
        rows = ""
        for r in reqs:
            action = f"/admin/confirmations/{r['id']}/confirm"
            rows += (f"<tr><td>{r['id']}</td><td>{r['kind']}</td><td>{r['case_id']}</td>"
                     f"<td><code>{r['object_digest'][:16]}…</code></td>"
                     f"<td>{self._form(action, label='确认')}</td></tr>")
        self._html(f"""<h1>待确认事项</h1>
<table><tr><th>ID</th><th>类型</th><th>案件</th><th>对象摘要</th><th>操作</th></tr>{rows}</table>
<p>确认即绑定对象摘要与一次性凭证；重复确认返回原结果，不产生第二个批准。</p>""")

    # ------------------------------------------------------------- POST
    def do_POST(self):
        if not self._check_origin():
            return self._html("<h1 class=warn>Origin 检查失败</h1>", 403)
        length = int(self.headers.get("Content-Length") or 0)
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()}
        path = urlparse(self.path).path
        if path == "/admin/login":
            if form.get("token") == STATE.password:
                session = secrets.token_urlsafe(24)
                STATE.sessions[session] = secrets.token_urlsafe(24)
                return self._redirect("/", {"Set-Cookie": f"fsession={session}; HttpOnly; SameSite=Strict; Path=/"})
            return self._login_page("口令不正确")
        if self._session() is None:
            return self._redirect("/")
        if not self._csrf_ok(form):
            return self._html("<h1 class=warn>CSRF 校验失败</h1>", 403)
        m = path.split("/")
        try:
            if len(m) == 5 and m[1] == "admin" and m[2] == "confirmations" and m[4] == "confirm":
                STATE.service.admin_confirm(m[3])
                return self._redirect("/admin/confirmations")
            if len(m) == 5 and m[1] == "admin" and m[2] == "cases" and m[4] == "freeze":
                qs = parse_qs(urlparse(self.path).query)
                STATE.service.admin_confirm_freeze(m[3], qs["run"][0])
                return self._redirect(f"/cases/{m[3]}/versions")
            if len(m) == 5 and m[1] == "admin" and m[2] == "cases" and m[4] == "prepare-export":
                qs = parse_qs(urlparse(self.path).query)
                STATE.service.freight_prepare_export(m[3], qs["run"][0], "核对材料")
                return self._redirect("/admin/confirmations")
            if len(m) == 6 and m[1] == "admin" and m[2] == "confirm-review":
                _, _, _, case_id, run_id, group_id = m
                svc = STATE.service
                decision = form.get("decision")
                reason = form.get("reason") or f"管理页决定 {decision}"
                prep = svc.freight_prepare_review(case_id, run_id, group_id, decision, reason)
                svc.admin_confirm(prep["confirmation_id"])
                return self._redirect(f"/cases/{case_id}/review/{run_id}/{group_id}")
            return self._html("<h1>404</h1>", 404)
        except FreightError as exc:
            return self._html(f"<h1>错误</h1><p class=warn>{exc.message}</p>", 400)


def main() -> None:
    global STATE
    port = int(os.environ.get("FREIGHT_ADMIN_PORT", "8765"))
    STATE = AdminState(DEFAULT_ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"admin page: http://127.0.0.1:{port}/  (local only)")
    server.serve_forever()


if __name__ == "__main__":
    main()
