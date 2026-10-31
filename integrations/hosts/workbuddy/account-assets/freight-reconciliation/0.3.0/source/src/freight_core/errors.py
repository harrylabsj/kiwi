"""错误码与异常体系。与 01_design/api-contracts.md 的错误码一一对应。

retryable 由错误本身确定：金额口径、规则冲突等语义错误不可通过重试解决。
"""
from __future__ import annotations

# 请求级错误码（api-contracts）
INVALID_INPUT = "INVALID_INPUT"
ACCESS_DENIED = "ACCESS_DENIED"
NOT_FOUND = "NOT_FOUND"
VERSION_CONFLICT = "VERSION_CONFLICT"
IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
SOURCE_TOTAL_MISMATCH = "SOURCE_TOTAL_MISMATCH"
RULE_UNCONFIRMED = "RULE_UNCONFIRMED"
RATE_AMBIGUOUS = "RATE_AMBIGUOUS"
JOB_PENDING = "JOB_PENDING"
RECOVERY_REQUIRED = "RECOVERY_REQUIRED"
LIMIT_EXCEEDED = "LIMIT_EXCEEDED"
FEATURE_UNSUPPORTED = "FEATURE_UNSUPPORTED"

# 不可重试：语义错误
NON_RETRYABLE = {ACCESS_DENIED, NOT_FOUND, VERSION_CONFLICT, IDEMPOTENCY_CONFLICT,
                 SOURCE_TOTAL_MISMATCH, RULE_UNCONFIRMED, RATE_AMBIGUOUS, LIMIT_EXCEEDED,
                 FEATURE_UNSUPPORTED, INVALID_INPUT}


class FreightError(Exception):
    code = INVALID_INPUT
    retryable = False

    def __init__(self, message: str, *, field_path: str | None = None,
                 recovery_action: str | None = None):
        super().__init__(message)
        self.message = message
        self.field_path = field_path
        self.recovery_action = recovery_action

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "retryable": self.retryable,
                "field_path": self.field_path, "recovery_action": self.recovery_action}


class InvalidInput(FreightError):
    code = INVALID_INPUT


class AccessDenied(FreightError):
    code = ACCESS_DENIED


class NotFound(FreightError):
    code = NOT_FOUND


class VersionConflict(FreightError):
    code = VERSION_CONFLICT


class IdempotencyConflict(FreightError):
    code = IDEMPOTENCY_CONFLICT


class SourceTotalMismatch(FreightError):
    code = SOURCE_TOTAL_MISMATCH


class RuleUnconfirmed(FreightError):
    code = RULE_UNCONFIRMED


class RateAmbiguous(FreightError):
    code = RATE_AMBIGUOUS


class LimitExceeded(FreightError):
    code = LIMIT_EXCEEDED
    retryable = False


class FeatureUnsupported(FreightError):
    code = FEATURE_UNSUPPORTED


class RecoveryRequired(FreightError):
    code = RECOVERY_REQUIRED
    retryable = True
