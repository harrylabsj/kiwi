/**
 * `kiwi weixin` CLI 测试——cmdWeixin 接线（全离线）。
 * 用 fake profile + mock iLink server + 预写凭证测成功路径；
 * 无效 base_url 测配置失败路径。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cmdWeixin, weixinUsage } from "../src/weixin/cli-weixin.js";

const workDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-wx-cli-"));
  workDirs.push(dir);
  return dir;
}

/** fake profile（离线 kernel）。 */
const FAKE_PROFILE = `runtime_version: 0.6.0
protocol_version: shopping.negotiation/0.1
agent_id: merchant-agent:merchant-001
role: merchant
owner_id: merchant-001
commerce:
  base_url: http://127.0.0.1:8765
  token_env: SHOPPING_AGENT_TOKEN
  backend: local_marketplace
model:
  provider: fake
  model: fake-chat-model
runtime:
  mode: once
  poll_interval_seconds: 5
  turn_timeout_seconds: 90
  max_model_steps: 4
  max_retries: 2
merchant_policy:
  min_unit_price_private: 80
  max_auto_discount_percent: 10
  inventory_source: marketplace
  quote_ttl_seconds: 300
  auto_negotiate: true
  human_review_on: []
`;

afterEach(() => {
  for (const d of workDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.KIWI_WEIXIN_BASE_URL;
  delete process.env.KIWI_WEIXIN_ALLOW_USERS;
});

describe("weixinUsage", () => {
  it("lists all flags", () => {
    const help = weixinUsage();
    for (const flag of ["--profile", "--data-dir", "--allow", "--relogin", "--a2a", "--qr-scale", "--no-qr"]) {
      expect(help).toContain(flag);
    }
    expect(help).toContain("微信远程控制");
  });
});

describe("cmdWeixin 接线（全离线）", () => {
  it("无效 base_url（不可达端口）→ 登录失败 → EXIT.CONFIG(2)", async () => {
    const dir = tempDir();
    const profileFile = path.join(dir, "profile.yaml");
    writeFileSync(profileFile, FAKE_PROFILE);
    // 无凭证 + base_url 指向不可达端口 → getBotQrcode network 失败 → CONFIG
    process.env.KIWI_WEIXIN_BASE_URL = "http://127.0.0.1:1";
    const code = await cmdWeixin({
      profile: profileFile,
      dataDir: dir,
      allow: undefined,
      relogin: false,
      a2a: false,
      port: undefined,
      qrScale: 1,
      noQr: true,
      catalog: undefined,
    });
    expect(code).toBe(2); // EXIT.CONFIG
  }, 20000);

  it("环境变量白名单解析（KIWI_WEIXIN_ALLOW_USERS）", async () => {
    const dir = tempDir();
    const profileFile = path.join(dir, "profile.yaml");
    writeFileSync(profileFile, FAKE_PROFILE);
    process.env.KIWI_WEIXIN_ALLOW_USERS = "wxid_a, wxid_b";
    process.env.KIWI_WEIXIN_BASE_URL = "http://127.0.0.1:1"; // 快速失败
    const code = await cmdWeixin({
      profile: profileFile,
      dataDir: dir,
      allow: undefined,
      relogin: false,
      a2a: false,
      port: undefined,
      qrScale: 1,
      noQr: true,
      catalog: undefined,
    });
    expect(code).toBe(2); // 白名单解析不阻断，登录仍失败 → CONFIG
  }, 20000);
});
