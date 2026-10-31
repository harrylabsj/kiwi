"""海纳·旅行专家引擎（离线优先，参考契约同版）。

分层：schemas（契约加载）→ results（ToolResult 统一）→ providers（快照/高德）
→ state（版本链+幂等）→ checks（检查服务）→ plan/audit/replan → exporters。
模型负责理解与候选；本引擎负责类型、计算、检查、版本与守卫。
"""
__version__ = '0.1.2'
