/**
 * UCP-Agent 头（RFC 8941 Structured Field Dictionary）—— 基线 §25.1 Platform
 * Profile Advertisement。HTTP-based A2A bindings 用它声明 platform（buyer）的
 * UCP profile URI。
 *
 * Wire 形状：
 *
 *   UCP-Agent: profile="https://buyer.example/.well-known/ucp"
 *
 *   - RFC 8941 Dictionary：`key=value` 成员，逗号分隔；
 *   - `profile` 成员是 String 类型 → 必须用双引号包裹、内部 `\` 与 `"` 转义；
 *   - 成员可带参数（`;...`），解析时忽略参数。
 *
 * 出站：A2AClientOptions.ucpAgentProfile 配置时由 client 注入。
 * 入站：server 解析并暴露给 handler（不强制 —— 头缺失/畸形只当未声明，绝不拒绝）。
 *
 * 零新增依赖；纯函数，无 I/O。
 */

export const UCP_AGENT_HEADER = "ucp-agent";
export const UCP_AGENT_PROFILE_MEMBER = "profile";

/** RFC 8941 §4.2.6 String 序列化：转义 `\` 与 `"` 后加引号。 */
export function serializeRfc8941String(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 单成员 `profile="<uri>"` 的字典序列化（§25.1）。 */
export function serializeUcpAgentHeader(profileUri: string): string {
  return `${UCP_AGENT_PROFILE_MEMBER}=${serializeRfc8941String(profileUri)}`;
}

/** RFC 8941 §4.2.6 String 反序列化（宽容：引号内非 `\"`/`\\` 转义按原样保留）。 */
export function unquoteRfc8941String(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return raw;
}

/**
 * 解析 UCP-Agent 头（RFC 8941 dictionary），取 `profile` 成员的值。
 * 头缺失 / 空 / 无 `profile` 成员 → undefined。成员参数（`;...`）被忽略。
 *
 * 只读解析（不强制）：畸形头返回 undefined，绝不导致请求被拒绝（§25.1
 * "缺省不拒绝"）。
 */
export function parseUcpAgentHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const joined = Array.isArray(value) ? value.join(",") : value;
  const members = joined
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  for (const member of members) {
    const eq = member.indexOf("=");
    if (eq <= 0) continue;
    const key = member.slice(0, eq).trim().toLowerCase();
    if (key !== UCP_AGENT_PROFILE_MEMBER) continue;
    const valuePart = member.slice(eq + 1).split(";")[0]!.trim();
    return unquoteRfc8941String(valuePart);
  }
  return undefined;
}
