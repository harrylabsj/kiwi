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
 * iLink 客户端身份（`base_info.channel_version` / `base_info.bot_agent`）。
 *
 * iLink 用 `bot_agent` 标识"驱动 bot 的应用"：缺省值是 `OpenClaw`，微信侧
 * 绑定/会话会按它显示应用名。kiwi 必须显式声明自身身份，否则会被识别成
 * OpenClaw（用户扫码绑定时看到的就是这个默认名）。
 */

import packageJson from "../../package.json" with { type: "json" };

/** 产品版本（与 npm 包版本同源，避免身份/版本漂移）。 */
export const WEIXIN_CHANNEL_VERSION = packageJson.version;

/** iLink `bot_agent` 取值（UA 风格 `<name>/<version>`，微信侧展示的应用名）。 */
export const WEIXIN_BOT_AGENT = `Kiwi/${packageJson.version}`;
