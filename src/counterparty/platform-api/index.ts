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
 * PlatformApiChannel — 平台 API 通道占位（基线 §5 / §33）。
 *
 * 本 WP 只落地接口占位 + fail-closed 默认实现（基线 §4.6 / §36）：
 *
 *   - 未配置平台凭证（configured=false）→ open 抛 ChannelError("platform_not_configured")，
 *     绝不静默降级到 hosted/direct（不变量 21）；
 *   - 已配置但实现尚未接线（未来 WP）→ send/getState 抛 ChannelError("not_implemented")。
 *
 * 平台 API 是权限最宽的通道（可能触碰平台侧订单/支付面），因此 fail-closed
 * 语义最严格：宁可拒绝，不猜、不降级。
 */

import {
  ChannelError,
  type ChannelHandle,
  type ChannelOpenInput,
  type CounterpartyChannel,
} from "../channel.js";

export interface PlatformApiChannelOptions {
  /** 是否已配置平台凭证。缺省 false（fail-closed）。 */
  configured?: boolean;
  /** 平台凭证引用（仅元数据，不承载 secret；不变量 24）。 */
  credentialRef?: string;
}

export class PlatformApiChannel implements CounterpartyChannel {
  readonly kind = "platform-api" as const;
  private readonly configured: boolean;
  private readonly credentialRef?: string;

  constructor(options: PlatformApiChannelOptions = {}) {
    this.configured = options.configured ?? false;
    this.credentialRef = options.credentialRef;
  }

  async open(input: ChannelOpenInput): Promise<ChannelHandle> {
    if (!this.configured) {
      throw new ChannelError(
        "platform-api",
        "platform_not_configured",
        "platform-api channel is not configured (no platform credentials); refusing to open (fail-closed, no silent downgrade)",
      );
    }
    return new PlatformApiHandle(input.identity, this.credentialRef);
  }
}

class PlatformApiHandle implements ChannelHandle {
  readonly kind = "platform-api" as const;
  readonly identity: string;
  private readonly credentialRef?: string;

  constructor(identity: string, credentialRef?: string) {
    this.identity = identity;
    this.credentialRef = credentialRef;
  }

  private notImplemented(): ChannelError {
    return new ChannelError(
      "platform-api",
      "not_implemented",
      `platform-api integration is not implemented (credential_ref=${this.credentialRef ?? "none"}); fail-closed`,
    );
  }

  async send(): Promise<never> {
    throw this.notImplemented();
  }

  async getState(): Promise<never> {
    throw this.notImplemented();
  }

  async close(): Promise<void> {
    // 占位：无资源需释放。
  }
}
