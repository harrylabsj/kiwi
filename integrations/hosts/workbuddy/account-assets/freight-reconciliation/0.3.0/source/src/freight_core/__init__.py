"""海纳·运费对账 Core。

业务事实、运算与人工决定保存在模型之外；本包是确定性核算与持久化的唯一权威。
金额一律整数"分"；时间一律带时区 ISO 串；未知一律 None，不用 0 伪装。
"""
ENGINE_VERSION = "0.1.0"
SCHEMA_VERSION = "0.1.0"
DISPLAY_TZ = "Asia/Shanghai"
