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
 * AgentKernel 装配（从 cli.ts 抽出，供 chat/weixin 等入口共享）。
 *
 * provider=fake 走确定性离线 chat fake；真实 provider 经 pi-ai builtin
 * 目录解析模型与认证。`catalog` 是 agent catalog base URL（buyer 的
 * negotiate_buyer_task 发现商家用）。从 cli.ts 机械抽取，无行为变化。
 */

import { agentDataDir, ensurePathsForDir } from "./agent-db.js";
import { createFakeChatModels } from "./fake-chat-model.js";
import { isAgentMode, type AgentMode } from "./mode.js";
import { AgentKernel, type AgentKernelOptions } from "./kernel.js";
import {
  ProfileError,
  RUNTIME_VERSION,
  resolveSecret,
  type AgentProfile,
} from "../config/profile.js";
import { HttpCommerceClient } from "../commerce/http-client.js";
import type { CommerceClient } from "../commerce/types.js";
import { isFakeProvider, resolveThinkingLevel } from "../runtime/model.js";

/** 裸 `kiwi` 的缺省 buyer profile（deepseek-v4-flash，环境变量可覆盖）。 */
export function defaultChatProfile(): AgentProfile {
  const provider = process.env.KIWI_MODEL_PROVIDER ?? "deepseek";
  const model = process.env.KIWI_MODEL ?? "deepseek-v4-flash";
  const apiKeyEnv = process.env.KIWI_MODEL_API_KEY_ENV ?? "DEEPSEEK_API_KEY";
  const baseUrl = process.env.KIWI_MODEL_BASE_URL;
  return {
    runtime_version: RUNTIME_VERSION,
    protocol_version: "shopping.negotiation/0.1",
    agent_id: "kiwi-assistant",
    role: "buyer",
    owner_id: "kiwi-user",
    commerce: {
      base_url: "http://127.0.0.1:8765",
      token_env: "SHOPPING_BUYER_TOKEN",
      backend: "local_marketplace",
    },
    model: {
      provider,
      model,
      api_key_env: apiKeyEnv,
      ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
    },
    runtime: {
      mode: "once",
      poll_interval_seconds: 5,
      turn_timeout_seconds: 90,
      max_model_steps: 4,
      max_retries: 2,
    },
    buyer_policy: {
      target_skus: [],
      quantity: 1,
      max_total_price_private: 1_000_000,
      acceptable_eta_latest: "2099-12-31T23:59:59+08:00",
      required_after_sales_terms: [],
      auto_negotiate: true,
      human_review_on: [],
    },
  };
}

/** 构建 commerce client（negotiation scope token 从 env 解析）。 */
export function buildClient(profile: AgentProfile): CommerceClient {
  const token = resolveSecret(profile.commerce.token_env, "commerce token");
  return new HttpCommerceClient({
    baseUrl: profile.commerce.base_url,
    token,
  });
}

/**
 * 为 profile 构建 AgentKernel（chat/weixin 共享装配）。
 * provider=fake 运行确定性离线 chat fake；真实 provider 解析模型与认证。
 */
export async function buildChatKernel(
  profile: AgentProfile,
  dataDir?: string,
  catalog?: string,
): Promise<AgentKernel> {
  const paths = ensurePathsForDir(dataDir ?? agentDataDir(profile.agent_id));

  let models: AgentKernelOptions["models"];
  let model: AgentKernelOptions["model"];
  let connector: AgentKernelOptions["connector"];
  let thinkingLevel: ReturnType<typeof resolveThinkingLevel>;
  let merchantClient: AgentKernelOptions["merchantClient"];
  let broker: AgentKernelOptions["broker"];
  let commerceClient: AgentKernelOptions["commerceClient"];
  if (isFakeProvider(profile)) {
    ({ models, model } = createFakeChatModels());
    if (profile.role === "buyer") {
      const { FakeCommerceConnector, fakeConnectorProduct } = await import(
        "./connector/fake-connector.js"
      );
      connector = new FakeCommerceConnector([
        fakeConnectorProduct(),
        fakeConnectorProduct({
          sku: "sku-002",
          title: "机制陶瓷杯",
          price: 59,
          stock: 0,
          merchant_id: "merchant-002",
        }),
      ]);
    } else {
      // Offline merchant chat: deterministic catalog client + dummy-scope
      // credentials so the capability pack is exercisable without a gateway.
      const { FakeMerchantClient, fakeMerchantProduct } = await import(
        "./merchant/fake-merchant-client.js"
      );
      const { StaticCredentialBroker } = await import(
        "./merchant/credential-broker.js"
      );
      merchantClient = new FakeMerchantClient({
        products: [fakeMerchantProduct()],
      });
      broker = new StaticCredentialBroker({
        negotiation: "fake-negotiation-token",
        catalog: "fake-catalog-token",
        inventory: "fake-inventory-token",
      });
    }
  } else {
    const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
    const collection = builtinModels();
    const found = collection.getModel(profile.model.provider, profile.model.model);
    if (found === undefined) {
      process.stderr.write(
        `no built-in model ${profile.model.provider}/${profile.model.model}; check the profile\n`,
      );
      throw new ProfileError(`no built-in model ${profile.model.provider}/${profile.model.model}`);
    }
    models = collection;
    model = found;
    thinkingLevel = resolveThinkingLevel(profile);
    if (profile.role === "buyer") {
      const { ShoppingCliConnector } = await import("./connector/http-connector.js");
      connector = new ShoppingCliConnector(profile.commerce.base_url, {
        buyerBootstrapToken: process.env.SHOPPING_BUYER_BOOTSTRAP_TOKEN,
      });
    }
    // Real gateway: negotiation client + scoped merchant client + broker.
    const { ProfileCredentialBroker } = await import(
      "./merchant/credential-broker.js"
    );
    broker = new ProfileCredentialBroker(profile);
    try {
      commerceClient = buildClient(profile);
    } catch {
      // No negotiation token: negotiation tools fail closed at call time.
      // Catalog/inventory 只读工具走公开搜索端点，不依赖该 token，仍会挂载。
      commerceClient = undefined;
      if (profile.role === "merchant") {
        process.stderr.write(
          `[kiwi] 未设置 ${profile.commerce.token_env}：磋商工具停用（fail closed），` +
            "目录/库存只读工具仍可用。\n",
        );
      }
    }
    if (profile.role === "merchant") {
      const { HttpMerchantClient } = await import("./merchant/merchant-client.js");
      merchantClient = new HttpMerchantClient(profile.commerce.base_url, broker);
    }
  }

  // KIWI_MODE env: start the chat already in the given write mode (e.g.
  // autopilot for autonomous negotiation) — no manual /mode needed.
  const kiwiMode = process.env.KIWI_MODE;
  const mode: AgentMode | undefined = isAgentMode(kiwiMode) ? kiwiMode : undefined;
  if (kiwiMode !== undefined && mode === undefined) {
    process.stderr.write(`unknown KIWI_MODE ${kiwiMode}（可选 ${["manual", "supervised", "autopilot"].join("/")}）\n`);
  }

  return AgentKernel.open({
    profile,
    paths,
    models,
    model,
    ...(mode !== undefined ? { mode } : {}),
    ...(connector !== undefined ? { connector } : {}),
    ...(commerceClient !== undefined ? { commerceClient } : {}),
    ...(merchantClient !== undefined ? { merchantClient } : {}),
    ...(broker !== undefined ? { broker } : {}),
    ...(catalog !== undefined ? { catalog } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  });
}
