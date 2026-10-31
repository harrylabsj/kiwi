"""海纳·运费对账 — 本地 stdio MCP 连接器（WorkBuddy 专家依赖此连接器，§18.2）。

- 一个连接器只配置一个 MCP Server；stdio 上换行分隔 JSON-RPC 2.0。
- 14 个工具输入契约取自 02_contracts/mcp-tools.draft.json（只读引用）。
- 统一响应包络：成功 {schema_version, request_id, case_id, case_revision, data, warnings,
  coverage}；失败 {schema_version, request_id, error{code,message,retryable,field_path,
  recovery_action}}，与 MCP isError 一致，请求级错误不返回半个成功金额。
- 安全（§17.2/§20.2）：workspace_id/actor_id/confirmed/approval_token 等受信字段出现在
  工具参数中一律拒绝；模型永远无法触达 admin_confirm。
- 长任务立即返回 job_id，客户端轮询 freight_get_job（§18.2 的 30 秒响应约束）。
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
# 开发树布局才把 src/ 插进 sys.path；pip/uvx 安装后 freight_core 已可直接导入。
if (REPO_ROOT / "src" / "freight_core").is_dir():
    sys.path.insert(0, str(REPO_ROOT / "src"))

from freight_core import SCHEMA_VERSION  # noqa: E402
from freight_core.errors import FreightError, InvalidInput  # noqa: E402
from freight_core.service import ReconciliationService  # noqa: E402

DEFAULT_ROOT = os.environ.get(
    "FREIGHT_RECON_ROOT",
    str(Path.home() / ".local" / "share" / "freight-reconciliation"))

TRUSTED_FIELDS = {"workspace_id", "actor_id", "confirmed", "approval_token",
                  "confirmation_ref", "nonce", "confirm", "activate", "release",
                  "approval", "approve"}

TOOL_NAMES = [
    "freight_create_case", "freight_register_asset", "freight_inspect_asset",
    "freight_prepare_mapping", "freight_prepare_rate_rules",
    "freight_list_match_candidates", "freight_prepare_match", "freight_start_run",
    "freight_get_job", "freight_get_summary", "freight_list_issues",
    "freight_get_evidence", "freight_prepare_review", "freight_prepare_export",
]

TOOL_DESCRIPTIONS = {
    "freight_create_case": "新建本地对账案件：主体工作区、承运商、账期边界与金额口径。单一 CNY。",
    "freight_register_asset": "登记来源文件（用户已选择的路径句柄）：bill/trips/rates/waiting/receipts/pod/history_trips。返回 asset_id，不接受任意系统路径以外的授权逃逸。",
    "freight_inspect_asset": "分页查看已登记资产的列名、脱敏样例、行数与解析问题。",
    "freight_prepare_mapping": "提交字段映射候选（原列→目标字段）。仅生成待确认草稿，不激活。",
    "freight_prepare_rate_rules": "把已导入的费率表打包为规则确认候选（含重叠/区间检查）。仅准备，不激活。",
    "freight_list_match_candidates": "列出待人工关联的账单行与候选运输（P3 仅建议，不自动绑定）。",
    "freight_prepare_match": "准备一条账单行与车次的人工关联候选。仅准备，不激活。",
    "freight_start_run": "启动一次确定性重算：冻结输入清单并返回 job_id，用 freight_get_job 轮询。",
    "freight_get_job": "查询 job 状态、完成/失败计数与恢复说明。",
    "freight_get_summary": "读取一版运行的金额汇总与覆盖率（分母明确，未知不归零）。",
    "freight_list_issues": "分页读取结构化差异/缺证/待匹配清单，不截断 JSON。",
    "freight_get_evidence": "读取单条异常的四栏证据定位（原账单/运输/规则凭证/计算轨迹），脱敏投影。",
    "freight_prepare_review": "准备一条人工复核决定候选（绑定 result_digest）。仅准备，不激活。",
    "freight_prepare_export": "准备导出候选（固定投影与用途）。不自动发送；释放需管理页确认。",
}


def _load_tool_schemas() -> dict:
    """契约读取三级回退（可移植，不依赖宿主注入的根路径）：

    1. FREIGHT_CONTRACTS_DIR 环境变量（显式覆盖）；
    2. 已安装的 freight_contracts 包资源（pip/uvx 形态）；
    3. 开发树 <repo>/02_contracts/。
    """
    candidates: list[Path] = []
    env_dir = os.environ.get("FREIGHT_CONTRACTS_DIR")
    if env_dir:
        candidates.append(Path(env_dir) / "mcp-tools.draft.json")
    try:
        from importlib import resources
        candidates.append(Path(str(
            resources.files("freight_contracts") / "mcp-tools.draft.json")))
    except Exception:  # noqa: BLE001 — 未安装形态走开发树回退
        pass
    candidates.append(REPO_ROOT / "02_contracts" / "mcp-tools.draft.json")
    for path in candidates:
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            tools = raw if isinstance(raw, list) else raw.get("tools", [])
            return {t["name"]: t for t in tools if isinstance(t, dict) and "name" in t}
    return {}


class McpServer:
    def __init__(self, root: str | None = None, service: ReconciliationService | None = None):
        self.service = service or ReconciliationService(root or DEFAULT_ROOT)
        self.schemas = _load_tool_schemas()
        self.dispatch = {
            "freight_create_case": self.service.freight_create_case,
            "freight_register_asset": self.service.freight_register_asset,
            "freight_inspect_asset": self.service.freight_inspect_asset,
            "freight_prepare_mapping": self.service.freight_prepare_mapping,
            "freight_prepare_rate_rules": self.service.freight_prepare_rate_rules,
            "freight_list_match_candidates": self.service.freight_list_match_candidates,
            "freight_prepare_match": self.service.freight_prepare_match,
            "freight_start_run": self.service.freight_start_run,
            "freight_get_job": self.service.freight_get_job,
            "freight_get_summary": self.service.freight_get_summary,
            "freight_list_issues": self.service.freight_list_issues,
            "freight_get_evidence": self.service.freight_get_evidence,
            "freight_prepare_review": self.service.freight_prepare_review,
            "freight_prepare_export": self.service.freight_prepare_export,
        }

    # ------------------------------------------------------------ MCP 协议
    def handle(self, message: dict) -> dict | None:
        method = message.get("method")
        msg_id = message.get("id")
        if method == "initialize":
            return self._result(msg_id, {
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "freight-reconciliation", "version": SCHEMA_VERSION},
            })
        if method == "notifications/initialized" or (msg_id is None
                                                     and str(method).startswith("notifications/")):
            return None
        if method == "tools/list":
            tools = [{
                "name": name,
                "description": TOOL_DESCRIPTIONS.get(name, name),
                "inputSchema": (self.schemas.get(name, {}).get("inputSchema")
                                or {"type": "object", "properties": {}}),
            } for name in TOOL_NAMES]
            return self._result(msg_id, {"tools": tools})
        if method == "tools/call":
            return self._result(msg_id, self._call_tool(message.get("params") or {}))
        return self._error(msg_id, -32601, f"method not found: {method}")

    def _call_tool(self, params: dict) -> dict:
        name = params.get("name")
        args = dict(params.get("arguments") or {})
        request_id = uuid.uuid4().hex[:16]
        if name not in self.dispatch:
            return self._tool_error(request_id, {
                "code": "INVALID_INPUT", "message": f"unknown tool {name}",
                "retryable": False, "field_path": "name", "recovery_action": None})
        leaked = TRUSTED_FIELDS.intersection(args)
        if leaked:  # 受信字段不进模型之手（api-contracts）
            return self._tool_error(request_id, {
                "code": "INVALID_INPUT",
                "message": f"trusted fields are rejected from tool input: {sorted(leaked)}",
                "retryable": False,
                "field_path": ",".join(sorted(leaked)),
                "recovery_action": "remove trusted fields; the server injects the workspace context"})
        try:
            data = self.dispatch[name](**self._coerce(name, args))
        except FreightError as exc:
            return self._tool_error(request_id, exc.to_dict())
        except TypeError as exc:
            return self._tool_error(request_id, {
                "code": "INVALID_INPUT", "message": str(exc), "retryable": False,
                "field_path": "arguments", "recovery_action": "check tool input schema"})
        except Exception as exc:  # noqa: BLE001 — 连接器进程绝不因单个坏请求而死
            sys.stderr.write(f"[mcp] internal error in {name}: {type(exc).__name__}: "
                             f"{exc}\n")
            return self._tool_error(request_id, {
                "code": "INTERNAL", "message": f"{type(exc).__name__}: {exc}",
                "retryable": True, "field_path": None,
                "recovery_action": "check arguments; if persistent, inspect connector logs"})
        case_id = (args.get("case_id") or (data or {}).get("case_id")
                   or (data or {}).get("id"))
        envelope = {
            "schema_version": SCHEMA_VERSION, "request_id": request_id,
            "case_id": case_id, "case_revision": self._case_revision(case_id),
            "data": data, "warnings": [], "coverage": None,
        }
        return {"content": [{"type": "text",
                             "text": json.dumps(envelope, ensure_ascii=False)}],
                "isError": False}

    @staticmethod
    def _coerce(name: str, args: dict) -> dict:
        """契约对齐与模型实机形态矫正（HV 实测发现）：

        - kind 按 02_contracts/mcp-tools.draft.json 枚举（TRIPS/BILL/RATES/POD/
          ACCESSORIAL/HISTORY）映射到 Core 内部小写类别；小写原值亦兼容；
        - upload_handle（契约名）→ upload_path（Core 参数名）；
        - header 传成 JSON 字符串时解析回列表；
        - fields 按契约的 [{source_column,target_field}] 转成映射 dict。
        """
        args = dict(args)
        kind_map = {"trips": "trips", "bill": "bill", "rates": "rates", "pod": "pod",
                    "accessorial": "waiting", "waiting": "waiting",
                    "history": "history_trips",
                    "receipts": "receipts", "history_trips": "history_trips"}
        if "kind" in args and isinstance(args["kind"], str):
            lowered = args["kind"].strip().lower()
            args["kind"] = kind_map.get(lowered, lowered)
        if "upload_handle" in args and "upload_path" not in args:
            args["upload_path"] = args.pop("upload_handle")
        header = args.get("header")
        if isinstance(header, str):
            try:
                header = json.loads(header)
            except json.JSONDecodeError:
                header = [c for c in header.split(",") if c.strip()]
            if not isinstance(header, list):
                raise ValueError("header must be a JSON array of column names")
            args["header"] = [str(h).strip() for h in header]
        fields = args.get("fields")
        if isinstance(fields, list):
            mapping = {}
            for item in fields:
                if isinstance(item, dict) and "source_column" in item:
                    mapping[str(item["source_column"])] = str(
                        item.get("target_field", item["source_column"]))
                elif isinstance(item, str):
                    mapping[item] = item
            args["fields"] = mapping
        elif isinstance(fields, str):
            try:
                args["fields"] = json.loads(fields)
            except json.JSONDecodeError:
                args["fields"] = None
        return args

    def _case_revision(self, case_id: str | None) -> int | None:
        if not case_id:
            return None
        row = self.service.db.conn.execute(
            "SELECT case_revision FROM cases WHERE id=?", (case_id,)).fetchone()
        return row[0] if row else None

    @staticmethod
    def _tool_error(request_id: str, err: dict) -> dict:
        envelope = {"schema_version": SCHEMA_VERSION, "request_id": request_id,
                    "error": err}
        return {"content": [{"type": "text",
                             "text": json.dumps(envelope, ensure_ascii=False)}],
                "isError": True}

    @staticmethod
    def _result(msg_id, result) -> dict:
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    @staticmethod
    def _error(msg_id, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": msg_id,
                "error": {"code": code, "message": message}}

    # ------------------------------------------------------------ stdio 主循环
    def serve(self) -> None:
        while True:  # readline 循环：逐行响应，不等待对端关闭
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                response = self._error(None, -32700, "parse error")
            else:
                response = self.handle(message)
            if response is not None:
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()


def main() -> None:
    McpServer().serve()


if __name__ == "__main__":
    main()
