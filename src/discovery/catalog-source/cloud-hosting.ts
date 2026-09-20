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
 * 云端托管的三个**互不替代**的轴（设计 v0.1.2 §11.1；T041）。
 *
 *   `card_hosting = "catalog"` —— 名片托管方是 Catalog（稳定读地址 + 签名绑定）；
 *   `runtime_hosting = <平台>` —— 运行时跑在哪（M3 部署为 WorkBuddy Cloud）；
 *   `communication_mode = "a2a-direct"` —— 询报价**不经过 Catalog**，Buyer 直连 Runtime。
 *
 * 三条纪律：
 *
 * 1. **旧枚举语义不动**：现有 `hosting.mode` 保持 `direct_only` 映射
 *    （`normalizeHostingMode` 原样保留 `direct → direct_only`、`hosted → hosted_only`）。
 *    云端商家**不得**被写成 `hosted_only`——那会让人以为询价经过 Catalog。
 * 2. **不往旧 register/DTO 里塞字段**：三个轴由**独立绑定/托管信息**承载（M3 即
 *    绑定声明 + 治理状态），不扩旧枚举、不改 `candidate-agent` DTO 形状。
 * 3. **`runtime_hosting` 是部署事实，不是协议字段**：它由调用方（知道自己跑在哪个
 *    平台上的一方）显式提供，**绝不从绑定声明等不可信输入里推导**——协议里没有
 *    这个值，猜一个等于把"猜出来的平台"讲成事实。
 */

/** 名片托管方：Catalog 的稳定读地址 + 签名绑定。 */
export const CARD_HOSTING_CATALOG = "catalog";

/** 通信模式：Buyer 与 Runtime 直连，Catalog 不转发询报价。 */
export const COMMUNICATION_MODE_A2A_DIRECT = "a2a-direct";

export interface CloudHostingAxes {
  card_hosting: typeof CARD_HOSTING_CATALOG;
  runtime_hosting: string;
  communication_mode: typeof COMMUNICATION_MODE_A2A_DIRECT;
}

export interface DescribeCloudHostingOptions {
  /**
   * 运行时所在平台（部署事实）。M3 的部署是 `"workbuddy_cloud"`。
   * **必填**：调用方给不出就不要描述这些轴，而不是让实现替你猜。
   */
  runtimeHosting: string;
}

/**
 * 描述一个**已经过 `CloudCardSource` 完整校验**的云端商家的三个轴。
 *
 * 只接受 `CloudAgentResolution` 的形态（而不是任意对象）：能走到这里就说明名片
 * 与绑定声明都已经验签、端点已比对、目标已过 SSRF 策略——三个轴是对**已证实事实**
 * 的命名，不是对候选的猜测。
 */
export function describeCloudHosting(
  resolution: { readonly endpoint: string; readonly claims: { readonly a2a_endpoint: string } },
  options: DescribeCloudHostingOptions,
): CloudHostingAxes {
  if (resolution.endpoint !== resolution.claims.a2a_endpoint) {
    throw new Error(
      "describeCloudHosting 只接受已校验的解析结果（端点必须由声明背书）",
    );
  }
  const runtimeHosting = options.runtimeHosting.trim();
  if (runtimeHosting === "") {
    throw new Error("runtimeHosting 必填——它是部署事实，不能由实现猜");
  }
  return {
    card_hosting: CARD_HOSTING_CATALOG,
    runtime_hosting: runtimeHosting,
    communication_mode: COMMUNICATION_MODE_A2A_DIRECT,
  };
}

/**
 * 云端商家在**旧** `hosting.mode` 语义下应记为什么。
 *
 * §11.1：「保留兼容字段时，现有 hosting_mode 映射为 direct，而不是 hosted_only」——
 * 旧枚举里的 `hosted_only` 意思是"询价走 Catalog 托管通道"，与 a2a-direct 恰好相反。
 * 任何把云端商家标成 `hosted_only` 的实现都是错的，这里用函数把规则钉住而不是
 * 散落在调用点。
 */
export function legacyHostingModeForCloudAgent(): "direct_only" {
  return "direct_only";
}
