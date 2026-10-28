import { writeFileAtomic } from "../fs/atomic-write.js";
import {
  MerchantTokenStatusError,
  rotateMerchantCredentialIfDue,
  type MerchantCredentialRotationOptions,
} from "../merchant-credential-rotation.js";

export interface CredentialRotationScheduleStatus {
  version: 1;
  merchant_id: string;
  enabled: boolean;
  poll_interval_seconds: number;
  rotate_before_seconds: number;
  supervisor_pid: number;
  started_at: string;
  last_check_at?: string;
  last_result?: "rotated" | "not_due" | "no_expiry" | "failed";
  expires_at?: string;
  seconds_remaining?: number | null;
  last_error?: "merchant_token_status_unavailable" | "rotation_failed";
  disabled_reason?: "catalog_token_ref_conflict" | "credential_file_unavailable" | "invalid_schedule_config";
}

class CredentialRotationScheduleRunError extends Error {
  constructor() {
    super("automatic merchant token rotation failed; run kiwi merchant doctor and credentials recover if a pending rotation exists");
  }
}

export function writeCredentialRotationScheduleStatus(file: string, status: CredentialRotationScheduleStatus): void {
  writeFileAtomic(file, `${JSON.stringify(status)}\n`, { mode: 0o600 });
}

/** One recoverable polling run. Only stable error codes are persisted; never persist request bodies or credentials. */
export async function runCredentialRotationSchedule(input: {
  statusPath: string;
  status: CredentialRotationScheduleStatus;
  rotation: MerchantCredentialRotationOptions & { rotateBeforeSeconds: number };
  now?: () => Date;
}): Promise<CredentialRotationScheduleStatus> {
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();
  try {
    const result = await rotateMerchantCredentialIfDue(input.rotation);
    const updated: CredentialRotationScheduleStatus = {
      ...input.status,
      last_check_at: checkedAt,
      last_result: result.status,
      expires_at: result.status === "rotated" ? "" : result.expiresAt,
      seconds_remaining: result.status === "rotated" ? null : result.secondsRemaining,
      last_error: undefined,
    };
    writeCredentialRotationScheduleStatus(input.statusPath, updated);
    return updated;
  } catch (error) {
    const updated: CredentialRotationScheduleStatus = {
      ...input.status,
      last_check_at: checkedAt,
      last_result: "failed",
      last_error: error instanceof MerchantTokenStatusError
        ? "merchant_token_status_unavailable"
        : "rotation_failed",
    };
    writeCredentialRotationScheduleStatus(input.statusPath, updated);
    throw new CredentialRotationScheduleRunError();
  }
}
