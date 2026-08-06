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
 * CounterpartyChannel 注册/装配：CounterpartyProfile → 具体通道实例。
 *
 * 候选选择是一次性确定性决策（selectChannelCandidate，§33）：direct → hosted →
 * platform。**不提供失败后自动退到更宽候选的机制**（不变量 21）——一旦选定
 * direct，其 send/getState 失败就向上抛 ChannelError，绝不静默降级。
 */

import type { CommerceClient } from "../commerce/types.js";
import type { IdempotencyStore } from "../negotiation/idempotency/index.js";
import type { LedgerStore } from "../negotiation/ledger/index.js";
import {
  ChannelError,
  selectChannelCandidate,
  type ChannelHandle,
  type ChannelOpenInput,
  type CounterpartyProfile,
} from "./channel.js";
import { A2ADirectChannel } from "./a2a-direct/index.js";
import { ShoppingCliHostedChannel } from "./shopping-cli-hosted/index.js";
import { PlatformApiChannel } from "./platform-api/index.js";

/** 装配通道所需的运行时依赖。 */
export interface ChannelRuntimeDeps {
  ledger?: LedgerStore;
  idempotency?: IdempotencyStore;
  /** hosted commerce client 提供者（按 config_id 解析）；返回 null 表示未配置。 */
  commerce?: (configId: string | undefined) => CommerceClient | null;
  /** platform 凭证状态（fail-closed）。 */
  platform?: { configured: boolean; credentialRef?: string };
  now?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 从 profile 打开一条通道（确定性选择首选候选，失败不降级）。
 *
 * 失败路径抛 ChannelError：
 *   - 无可用候选 → no_channel_candidate；
 *   - a2a-direct 候选缺 url → no_channel_candidate；
 *   - hosted 候选但未配置 commerce client → commerce_client_not_configured；
 *   - platform 候选但未配置凭证 → platform_not_configured。
 */
export async function openChannel(
  profile: CounterpartyProfile,
  deps: ChannelRuntimeDeps,
  input: ChannelOpenInput,
): Promise<ChannelHandle> {
  const candidate = selectChannelCandidate(profile);
  if (candidate === null) {
    throw new ChannelError(
      "platform-api",
      "no_channel_candidate",
      `no usable channel candidate for counterparty ${profile.identity}`,
    );
  }

  switch (candidate.kind) {
    case "a2a-direct": {
      if (candidate.url === undefined) {
        throw new ChannelError("a2a-direct", "no_channel_candidate", "a2a-direct candidate is missing url");
      }
      const channel = new A2ADirectChannel({
        url: candidate.url,
        ledger: deps.ledger,
        idempotency: deps.idempotency,
        now: deps.now,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs ?? input.timeoutMs,
      });
      return channel.open(input);
    }
    case "shopping-cli-hosted": {
      const client = deps.commerce?.(candidate.config_id) ?? null;
      if (client === null) {
        throw new ChannelError(
          "shopping-cli-hosted",
          "commerce_client_not_configured",
          "shopping-cli-hosted candidate selected but no commerce client is configured (config_id=" +
            `${candidate.config_id ?? "default"})`,
        );
      }
      const channel = new ShoppingCliHostedChannel({
        client,
        ledger: deps.ledger,
        now: deps.now,
      });
      return channel.open(input);
    }
    case "platform-api": {
      const channel = new PlatformApiChannel({
        configured: deps.platform?.configured ?? false,
        credentialRef: deps.platform?.credentialRef ?? candidate.credential_ref,
      });
      return channel.open(input);
    }
  }
}
