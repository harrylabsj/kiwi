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
 * Merchant MCP 运行时的数据目录接线（V2 §5.1）。
 *
 * 显式三个槽位分别注入，互不派生：
 *   - merchantDataDir   商家维度数据（a2a ledger、stats、oauth.sqlite）——
 *                       同一商家的多个传输会话共享同一目录；
 *   - principalDataDir  principal 维度数据（审批候选 state.sqlite 等）——
 *                       当前与 merchantDataDir 同址（单商家实例唯一 principal），
 *                       槽位分离是为多 principal 演进留的机械拆分点；
 *   - transportSessionId 传输会话标识（无状态 streamableHttp 固定 "stateless"）——
 *                       只是观测标签，绝不参与数据目录派生（修掉「HTTP adapter
 *                       按 sessionId 建 dataDir」的接线形态：会话不得影响持久路径）。
 *
 * 不变量：路径是 (dataDir?, agentId) 的纯函数——重启后路径稳定；
 * 任何传输会话的加入/退出都不改变目录。
 */

import { agentDataDir } from "../agent/agent-db.js";

/** 无状态传输的固定会话标识（仅观测用；绝不参与路径派生）。 */
export const STATELESS_TRANSPORT_SESSION_ID = "stateless";

export interface MerchantMcpRuntimeDirs {
  merchantDataDir: string;
  principalDataDir: string;
  transportSessionId: string;
}

export function resolveMerchantMcpDirs(options: {
  dataDir?: string;
  agentId: string;
}): MerchantMcpRuntimeDirs {
  // agentDataDir 经 agentDirName 消毒（防路径逃逸），与 chat kernel 同一缺省。
  const merchantDataDir = options.dataDir ?? agentDataDir(options.agentId);
  return {
    merchantDataDir,
    principalDataDir: merchantDataDir,
    transportSessionId: STATELESS_TRANSPORT_SESSION_ID,
  };
}
