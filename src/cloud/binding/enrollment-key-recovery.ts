/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** 受管的失钥/疑似泄漏恢复：Runtime停止时轮换持久A2A密钥，旧Catalog绑定由重新授权替换。 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../fs/atomic-write.js";
import {
  generateA2aSigningIdentity,
  loadA2aSigningIdentityFromFile,
  A2A_SIGNING_KEY_FILE,
} from "../../a2a/signing-key.js";

export class EnrollmentKeyRecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EnrollmentKeyRecoveryError";
  }
}

const OWNER_LOCK_FILE = "owner.lock";
const ROTATION_LOCK_FILE = "key-rotation.lock";

function assertPrivateRegularFile(filePath: string): void {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    throw new EnrollmentKeyRecoveryError(
      "KEY_UNAVAILABLE",
      `${path.basename(filePath)} 不存在或无法读取；未修改 Runtime 身份。`,
    );
  }
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
    throw new EnrollmentKeyRecoveryError(
      "KEY_STORAGE_UNSAFE",
      `${path.basename(filePath)} 必须是权限为 0600 的普通文件；请先保护本地数据目录。`,
    );
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
      return false;
    // EPERM 等情况不能证明进程已停止，必须fail-closed。
    return true;
  }
}

/**
 * 替换本地持久签名密钥。调用前必须运行 `kiwi merchant runtime stop`。
 *
 * 本函数先取得与 A2A server 共用的数据目录互斥标志，再核验 PID 锁，避免
 * 在仍有进程持有旧私钥时轮换。旧私钥不备份；EnrollmentStore 保留旧binding
 * 回执，后续connect需要重新经过Catalog登录/授权并以新公钥证明持有。旧绑定
 * 只在Catalog确认新绑定时撤销，不能在本地谎报撤销成功。
 */
export function rotateEnrollmentSigningKey(
  dataDir: string,
  newKeyId: string,
): { oldKeyId: string; newKeyId: string } {
  const keyId = String(newKeyId ?? "").trim();
  if (!keyId || keyId.length > 512 || /[\r\n]/.test(keyId)) {
    throw new EnrollmentKeyRecoveryError(
      "INVALID_KEY_ID",
      "签名身份标识无效；未修改 Runtime 身份。请确认公网 HTTPS 地址/商家 profile 后重试。",
    );
  }
  const keyPath = path.join(dataDir, A2A_SIGNING_KEY_FILE);
  assertPrivateRegularFile(keyPath);
  let oldIdentity;
  try {
    oldIdentity = loadA2aSigningIdentityFromFile(keyPath);
  } catch {
    throw new EnrollmentKeyRecoveryError(
      "KEY_INVALID",
      "现有 Runtime 密钥损坏或格式不符；未替换文件。请走支持的数据恢复流程。",
    );
  }

  const stateDir = path.join(dataDir, "a2a");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const ownerLock = path.join(stateDir, OWNER_LOCK_FILE);
  const rotationLock = path.join(stateDir, ROTATION_LOCK_FILE);
  let fd: number;
  try {
    fd = openSync(rotationLock, "wx", 0o600);
  } catch {
    throw new EnrollmentKeyRecoveryError(
      "ROTATION_ALREADY_RUNNING",
      "另一项 Runtime 身份维护正在运行；未修改密钥。稍后重试。",
    );
  }
  try {
    writeSync(fd, String(process.pid));
    closeSync(fd);
    if (existsSync(ownerLock)) {
      let pidText: string;
      try {
        pidText = readFileSync(ownerLock, "utf8").trim();
      } catch {
        throw new EnrollmentKeyRecoveryError(
          "RUNTIME_LOCK_UNREADABLE",
          "无法确认 A2A 服务是否停止；请关闭运行进程后重试。",
        );
      }
      if (!/^\d{1,12}$/.test(pidText) || isProcessAlive(Number(pidText))) {
        throw new EnrollmentKeyRecoveryError(
          "RUNTIME_STILL_RUNNING",
          "A2A 服务仍在运行；先执行 `kiwi merchant runtime stop`，再轮换密钥。没有修改密钥。",
        );
      }
      // 不删除server自己的残留锁；A2A Node启动时按既有stale-lock规则接管。
    }
    const identity = generateA2aSigningIdentity(keyId);
    writeFileAtomic(
      keyPath,
      `${JSON.stringify(
        {
          keyid: identity.keyid,
          algorithm: identity.algorithm,
          privateKeyPem: identity.privateKeyPem,
          publicKeyPem: identity.publicKeyPem,
          publicKeyRaw: identity.publicKeyRaw.toString("base64"),
          created_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    assertPrivateRegularFile(keyPath);
    return { oldKeyId: oldIdentity.keyid, newKeyId: identity.keyid };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(rotationLock);
    } catch {
      /* visible on next attempt */
    }
  }
}
