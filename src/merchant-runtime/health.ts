/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Merchant 实例分项健康检查（V2 阶段一：src/merchant-runtime/health.ts）。
 *
 * 分项：受管进程存活、商品源（shopping-cli 能力探测结果，读
 * capability-probe.json 落盘记录——探测本身在 merchant-client.ts）、状态
 * 目录可写、磁盘余量。输出结构化健康报告；任一分项失败 → ok:false，
 * 不吞错不编造（fail-closed 口径与能力探测一致）。
 */

import { existsSync, readFileSync, statfsSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { ManagedServiceState } from "./manager.js";
import type { MerchantCapabilityProbe } from "../agent/merchant/merchant-client.js";

export interface MerchantAlert {
  code:
    | "process_down"
    | "product_source_unavailable"
    | "registration_invalid"
    | "backlog"
    | "disk_low"
    | "cert_expiring";
  severity: "critical" | "warning";
  message: string;
}

export interface MerchantHealthReport {
  ok: boolean;
  checked_at: string;
  checks: {
    processes: { ok: boolean; services: ManagedServiceState[] };
    product_source: { ok: boolean; version?: string; error?: string };
    data_dir: { ok: boolean; path: string; writable: boolean };
    disk: { ok: boolean; free_bytes?: number };
  };
  /** 结构化告警事件（V2 阶段四 7×24；超阈值/失效即产生，可供通知通道消费）。 */
  alerts: MerchantAlert[];
}

/** 磁盘余量下限（字节；缺省 100MB）。 */
export const MIN_FREE_BYTES = 100 * 1024 * 1024;
/** 待处理命令积压告警阈值（缺省 50）。 */
export const BACKLOG_ALERT_THRESHOLD = 50;
/** 证书临期告警阈值（天；缺省 14）。 */
export const CERT_EXPIRING_DAYS = 14;

export interface MerchantHealthDeps {
  /** merchantDataDir（V2 §5.1）。 */
  dataDir: string;
  /** 受管服务状态（来自 MerchantRuntimeManager.status()）。 */
  services: ManagedServiceState[];
  now?: () => string;
  minFreeBytes?: number;
  /** 待处理命令数（积压告警；缺省 0）。 */
  pendingCommands?: number;
  /** 注册检查报告（F25；缺省不评）。 */
  registration?: { ok: boolean; error?: string };
  /** TLS 证书剩余天数（可选；配置了才评）。 */
  certDaysLeft?: number;
}

export function collectMerchantHealth(deps: MerchantHealthDeps): MerchantHealthReport {
  const checkedAt = (deps.now ?? (() => new Date().toISOString()))();
  const minFree = deps.minFreeBytes ?? MIN_FREE_BYTES;

  const processes = {
    ok: deps.services.every((s) => s.running),
    services: deps.services,
  };

  // 商品源：读能力探测落盘记录（探测动作在 mcp serve 启动/健康轮询时执行）。
  const probePath = path.join(deps.dataDir, "capability-probe.json");
  let productSource: MerchantHealthReport["checks"]["product_source"];
  if (!existsSync(probePath)) {
    productSource = { ok: false, error: "无能力探测记录（capability-probe.json 不存在）" };
  } else {
    try {
      const probe = JSON.parse(readFileSync(probePath, "utf8")) as MerchantCapabilityProbe;
      productSource = {
        ok: probe.ok === true,
        ...(probe.version !== undefined ? { version: probe.version } : {}),
        ...(probe.error !== undefined ? { error: probe.error } : {}),
      };
    } catch (err) {
      productSource = {
        ok: false,
        error: `能力探测记录损坏：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 状态目录可写（写探针文件即删）
  let writable = false;
  const probe = path.join(deps.dataDir, "runtime", ".health-probe");
  try {
    writeFileSync(probe, checkedAt, { mode: 0o600 });
    rmSync(probe, { force: true });
    writable = true;
  } catch {
    writable = false;
  }

  let freeBytes: number | undefined;
  try {
    const fs = statfsSync(deps.dataDir);
    freeBytes = fs.bavail * fs.bsize;
  } catch {
    freeBytes = undefined;
  }

  const checks = {
    processes,
    product_source: productSource,
    data_dir: { ok: writable, path: deps.dataDir, writable },
    disk: {
      ok: freeBytes !== undefined && freeBytes >= minFree,
      ...(freeBytes !== undefined ? { free_bytes: freeBytes } : {}),
    },
  };

  // 结构化告警（7×24；每个告警有明确 code/severity，供通知通道消费）。
  const alerts: MerchantAlert[] = [];
  for (const s of deps.services) {
    if (!s.running) {
      alerts.push({
        code: "process_down",
        severity: "critical",
        message: `受管进程 ${s.name} 未运行`,
      });
    }
  }
  if (!productSource.ok) {
    alerts.push({
      code: "product_source_unavailable",
      severity: "critical",
      message: `商品源不可用：${productSource.error ?? "未知"}`,
    });
  }
  if (deps.registration !== undefined && !deps.registration.ok) {
    alerts.push({
      code: "registration_invalid",
      severity: "critical",
      message: `catalog 注册失效：${deps.registration.error ?? "未知"}`,
    });
  }
  const pending = deps.pendingCommands ?? 0;
  if (pending > BACKLOG_ALERT_THRESHOLD) {
    alerts.push({
      code: "backlog",
      severity: "warning",
      message: `待处理命令积压 ${pending}（阈值 ${BACKLOG_ALERT_THRESHOLD}）`,
    });
  }
  if (!checks.disk.ok) {
    alerts.push({ code: "disk_low", severity: "warning", message: "磁盘余量低于下限" });
  }
  if (deps.certDaysLeft !== undefined && deps.certDaysLeft <= CERT_EXPIRING_DAYS) {
    alerts.push({
      code: "cert_expiring",
      severity: deps.certDaysLeft <= 3 ? "critical" : "warning",
      message: `TLS 证书 ${deps.certDaysLeft} 天后到期`,
    });
  }

  return {
    ok: Object.values(checks).every((c) => c.ok),
    checked_at: checkedAt,
    checks,
    alerts,
  };
}
