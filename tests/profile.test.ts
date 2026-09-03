import { afterEach, describe, expect, it } from "vitest";
import {chmodSync, mkdtempSync, rmSync, statSync, writeFileSync} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findInlineSecrets,
  loadProfile,
  ProfileError,
  resolveSecret,
} from "../src/config/profile.js";

const VALID_YAML = `
runtime_version: 0.5.0
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
  model: fake-merchant-model
runtime:
  mode: once
  poll_interval_seconds: 5
  turn_timeout_seconds: 90
  max_model_steps: 4
  max_retries: 2
merchant_policy:
  min_unit_price_private: 80.00
  quote_ttl_seconds: 300
`;

function writeTemp(content: string): string {
  const dir = trackedMkdtemp("kiwi-profile-");
  const file = path.join(dir, "profile.yaml");
  writeFileSync(file, content);
  return file;
}

describe("profile loading", () => {
  it("K-L16: group/world-readable profile is auto-tightened to 0600", () => {
    const file = writeTemp(VALID_YAML);
    chmodSync(file, 0o644); // 显式设为过宽权限
    const profile = loadProfile(file);
    expect(profile.agent_id).toBe("merchant-agent:merchant-001");
    // 审查 K-L16：loadProfile 后权限收紧为 0600（含私有预算的 profile 不再
    // 被同机其他用户读取）。
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("loads a valid merchant profile", () => {
    const profile = loadProfile(writeTemp(VALID_YAML));
    expect(profile.agent_id).toBe("merchant-agent:merchant-001");
    expect(profile.role).toBe("merchant");
    expect(profile.commerce.token_env).toBe("SHOPPING_AGENT_TOKEN");
    expect(profile.merchant_policy?.min_unit_price_private).toBe(80);
  });

  it("loads explicit prompt cache retention and rejects unsupported values", () => {
    const withCache = `${VALID_YAML}\nmerchant_experience:\n  enabled: true\n  prompt_cache_retention: long\n`;
    const profile = loadProfile(writeTemp(withCache));
    expect(profile.merchant_experience?.prompt_cache_retention).toBe("long");

    const bad = withCache.replace("prompt_cache_retention: long", "prompt_cache_retention: forever");
    expect(() => loadProfile(writeTemp(bad))).toThrow(/prompt_cache_retention/);
  });

  it("loads optional per-scope credential env refs (§15.4) and rejects bad ones", () => {
    const withCreds = VALID_YAML.replace(
      "  backend: local_marketplace",
      `  backend: local_marketplace
  credentials:
    catalog:
      token_env: SHOPPING_CATALOG_TOKEN
    inventory:
      token_env: SHOPPING_INVENTORY_TOKEN`,
    );
    const profile = loadProfile(writeTemp(withCreds));
    expect(profile.commerce.credentials?.catalog?.token_env).toBe("SHOPPING_CATALOG_TOKEN");
    expect(profile.commerce.credentials?.inventory?.token_env).toBe("SHOPPING_INVENTORY_TOKEN");
    expect(profile.commerce.credentials?.negotiation).toBeUndefined();

    // Unknown scope fails closed.
    const badScope = withCreds.replace("inventory:", "payments:");
    expect(() => loadProfile(writeTemp(badScope))).toThrow(/credentials has unknown scope/);

    // A scope entry without token_env fails closed.
    const noEnv = withCreds.replace("token_env: SHOPPING_INVENTORY_TOKEN", "token: inline-secret");
    expect(() => loadProfile(writeTemp(noEnv))).toThrow(/token_env/);

    // A non-env-var name fails closed.
    const badName = withCreds.replace("SHOPPING_INVENTORY_TOKEN", "my-token");
    expect(() => loadProfile(writeTemp(badName))).toThrow(/token_env/);
  });

  it("rejects missing file", () => {
    expect(() => loadProfile("/nonexistent/profile.yaml")).toThrow(ProfileError);
  });

  it("rejects wrong protocol version", () => {
    const bad = VALID_YAML.replace("shopping.negotiation/0.1", "shopping.negotiation/9.9");
    expect(() => loadProfile(writeTemp(bad))).toThrow(/protocol_version/);
  });

  it("rejects inline token values (only *_env references allowed)", () => {
    const bad = VALID_YAML.replace("token_env: SHOPPING_AGENT_TOKEN", "token: sk-live-secret");
    expect(() => loadProfile(writeTemp(bad))).toThrow(/token_env/);
  });

  it("rejects malformed env var names", () => {
    const bad = VALID_YAML.replace("token_env: SHOPPING_AGENT_TOKEN", "token_env: my-token");
    expect(() => loadProfile(writeTemp(bad))).toThrow(/token_env/);
  });

  it("rejects invalid runtime limits", () => {
    const bad = VALID_YAML.replace("max_model_steps: 4", "max_model_steps: 0");
    expect(() => loadProfile(writeTemp(bad))).toThrow(/max_model_steps/);
  });

  it("flags inline secrets in the raw document", () => {
    const withSecret = { commerce: { token: "abc123", token_env: "OK_NAME" } };
    expect(findInlineSecrets(withSecret)).toEqual(["commerce.token"]);
    expect(findInlineSecrets({ commerce: { token_env: "OK_NAME" } })).toEqual([]);
  });

  it("resolveSecret reads only from environment", () => {
    process.env.KIWI_TEST_SECRET = "s3cret";
    expect(resolveSecret("KIWI_TEST_SECRET", "test")).toBe("s3cret");
    delete process.env.KIWI_TEST_SECRET;
    expect(() => resolveSecret("KIWI_TEST_SECRET", "test")).toThrow(ProfileError);
  });
});

const BUYER_YAML = `
runtime_version: 0.5.0
protocol_version: shopping.negotiation/0.1
agent_id: buyer-agent:buyer-001
role: buyer
owner_id: buyer-001
commerce:
  base_url: http://127.0.0.1:8765
  token_env: SHOPPING_BUYER_TOKEN
  backend: local_marketplace
model:
  provider: fake
  model: fake-buyer-model
runtime:
  mode: once
  poll_interval_seconds: 5
  turn_timeout_seconds: 90
  max_model_steps: 4
  max_retries: 2
buyer_policy:
  target_skus:
    - sku-001
  quantity: 2
  max_total_price_private: 200.00
  acceptable_eta_latest: "2026-08-05T18:00:00+08:00"
  required_after_sales_terms:
    - policy:return-7d
  auto_negotiate: true
  human_review_on:
    - budget_exceeded
`;

describe("buyer_policy validation", () => {
  const withChange = (from: string, to: string): string => {
    expect(BUYER_YAML).toContain(from);
    return BUYER_YAML.replace(from, to);
  };

  it("loads a valid buyer profile", () => {
    const profile = loadProfile(writeTemp(BUYER_YAML));
    expect(profile.role).toBe("buyer");
    expect(profile.buyer_policy?.max_total_price_private).toBe(200);
    expect(profile.buyer_policy?.quantity).toBe(2);
    expect(profile.buyer_policy?.target_skus).toEqual(["sku-001"]);
    expect(profile.merchant_policy).toBeUndefined();
  });

  it("buyer without buyer_policy fails closed", () => {
    const bad = BUYER_YAML.replace(/buyer_policy:[\s\S]*$/, "");
    expect(() => loadProfile(writeTemp(bad))).toThrow(/role=buyer requires a buyer_policy/);
  });

  it("role policies are mutually exclusive", () => {
    const withMerchant = `${BUYER_YAML}merchant_policy:\n  min_unit_price_private: 80\n`;
    expect(() => loadProfile(writeTemp(withMerchant))).toThrow(
      /role=buyer must not define merchant_policy/,
    );
    const merchantWithBuyer = `${VALID_YAML}buyer_policy:\n  target_skus: []\n  quantity: 1\n  max_total_price_private: 1\n  acceptable_eta_latest: "2026-08-05T18:00:00+08:00"\n  required_after_sales_terms: []\n  auto_negotiate: true\n  human_review_on: []\n`;
    expect(() => loadProfile(writeTemp(merchantWithBuyer))).toThrow(
      /role=merchant must not define buyer_policy/,
    );
  });

  it("merchant without merchant_policy fails closed", () => {
    const bad = VALID_YAML.replace(/merchant_policy:[\s\S]*$/, "");
    expect(() => loadProfile(writeTemp(bad))).toThrow(/role=merchant requires a merchant_policy/);
  });

  it("rejects unknown buyer_policy fields", () => {
    expect(() =>
      loadProfile(
        writeTemp(withChange("auto_negotiate: true", "auto_negotiate: true\n  sneaky: 1")),
      ),
    ).toThrow(/buyer_policy has unknown field "sneaky"/);
  });

  it("requires every buyer_policy field", () => {
    const removals: [string, RegExp][] = [
      ["target_skus", /^ {2}target_skus:\n {4}- sku-001\n/m],
      ["quantity", /^ {2}quantity: 2\n/m],
      ["max_total_price_private", /^ {2}max_total_price_private: 200\.00\n/m],
      ["acceptable_eta_latest", /^ {2}acceptable_eta_latest: "2026-08-05T18:00:00\+08:00"\n/m],
      ["required_after_sales_terms", /^ {2}required_after_sales_terms:\n {4}- policy:return-7d\n/m],
      ["auto_negotiate", /^ {2}auto_negotiate: true\n/m],
      ["human_review_on", /^ {2}human_review_on:\n {4}- budget_exceeded\n/m],
    ];
    for (const [key, pattern] of removals) {
      const bad = BUYER_YAML.replace(pattern, "");
      expect(bad).not.toBe(BUYER_YAML);
      expect(() => loadProfile(writeTemp(bad)), key).toThrow(
        new RegExp(`buyer_policy.${key} is required`),
      );
    }
  });

  it("validates buyer_policy field types and ranges", () => {
    expect(() => loadProfile(writeTemp(withChange("quantity: 2", "quantity: 0")))).toThrow(
      /quantity must be a positive integer/,
    );
    expect(() => loadProfile(writeTemp(withChange("quantity: 2", "quantity: 1.5")))).toThrow(
      /quantity must be a positive integer/,
    );
    expect(() =>
      loadProfile(
        writeTemp(withChange("max_total_price_private: 200.00", "max_total_price_private: -1")),
      ),
    ).toThrow(/max_total_price_private must be >= 0/);
    expect(() =>
      loadProfile(
        writeTemp(withChange("max_total_price_private: 200.00", "max_total_price_private: .nan")),
      ),
    ).toThrow(/finite number/);
    expect(() =>
      loadProfile(writeTemp(withChange("target_skus:\n    - sku-001", "target_skus: sku-001"))),
    ).toThrow(/target_skus must be a list of non-empty strings/);
    expect(() =>
      loadProfile(writeTemp(withChange("auto_negotiate: true", "auto_negotiate: yes"))),
    ).toThrow(/auto_negotiate must be a boolean/);
    expect(() =>
      loadProfile(
        writeTemp(
          withChange("human_review_on:\n    - budget_exceeded", "human_review_on:\n    - ''"),
        ),
      ),
    ).toThrow(/human_review_on must be a list of non-empty strings/);
    expect(() =>
      loadProfile(
        writeTemp(
          withChange(
            "required_after_sales_terms:\n    - policy:return-7d",
            "required_after_sales_terms: policy:return-7d",
          ),
        ),
      ),
    ).toThrow(/required_after_sales_terms must be a list of non-empty strings/);
  });

  it("requires acceptable_eta_latest to be RFC 3339 with an explicit timezone", () => {
    for (const bad of [
      '"2026-08-05T18:00:00"', // naive: no timezone
      '"2026-08-05"', // date only
      '"next friday"',
      '"2026-13-05T18:00:00+08:00"', // invalid month
    ]) {
      expect(
        () => loadProfile(writeTemp(withChange('"2026-08-05T18:00:00+08:00"', bad))),
        bad,
      ).toThrow(/acceptable_eta_latest must be an RFC 3339 date-time with an explicit timezone/);
    }
    // Zulu time and fractional seconds are fine.
    const good = loadProfile(
      writeTemp(withChange('"2026-08-05T18:00:00+08:00"', '"2026-08-05T10:00:00.500Z"')),
    );
    expect(good.buyer_policy?.acceptable_eta_latest).toBe("2026-08-05T10:00:00.500Z");
  });
});

describe("profile strict validation", () => {
  const withChange = (from: string, to: string): string => {
    expect(VALID_YAML).toContain(from);
    return VALID_YAML.replace(from, to);
  };

  it("rejects unknown fields at every level", () => {
    expect(() => loadProfile(writeTemp(`${VALID_YAML}unknown_top: true\n`))).toThrow(
      /unknown field "unknown_top"/,
    );
    expect(() =>
      loadProfile(
        writeTemp(
          withChange("backend: local_marketplace", "backend: local_marketplace\n  extra: 1"),
        ),
      ),
    ).toThrow(/commerce has unknown field "extra"/);
    expect(() =>
      loadProfile(
        writeTemp(
          withChange(
            "model: fake-merchant-model",
            "model: fake-merchant-model\n  temperature: 0.5",
          ),
        ),
      ),
    ).toThrow(/model has unknown field "temperature"/);
    expect(() =>
      loadProfile(writeTemp(withChange("max_retries: 2", "max_retries: 2\n  jitter: true"))),
    ).toThrow(/runtime has unknown field "jitter"/);
    expect(() =>
      loadProfile(
        writeTemp(
          withChange(
            "min_unit_price_private: 80.00",
            "min_unit_price_private: 80.00\n  secret_floor_note: hi",
          ),
        ),
      ),
    ).toThrow(/merchant_policy has unknown field/);
  });

  it("rejects NaN and Infinity in numeric fields", () => {
    expect(() =>
      loadProfile(writeTemp(withChange("turn_timeout_seconds: 90", "turn_timeout_seconds: .inf"))),
    ).toThrow(/finite number/);
    expect(() =>
      loadProfile(writeTemp(withChange("poll_interval_seconds: 5", "poll_interval_seconds: .nan"))),
    ).toThrow(/finite number/);
    expect(() =>
      loadProfile(
        writeTemp(withChange("min_unit_price_private: 80.00", "min_unit_price_private: .nan")),
      ),
    ).toThrow(/finite number/);
  });

  it("enforces runtime upper bounds", () => {
    expect(() =>
      loadProfile(writeTemp(withChange("max_model_steps: 4", "max_model_steps: 21"))),
    ).toThrow(/max_model_steps must be <= 20/);
    expect(() => loadProfile(writeTemp(withChange("max_retries: 2", "max_retries: 6")))).toThrow(
      /max_retries must be <= 5/,
    );
    expect(() =>
      loadProfile(writeTemp(withChange("turn_timeout_seconds: 90", "turn_timeout_seconds: 3601"))),
    ).toThrow(/turn_timeout_seconds must be > 0 and <= 3600/);
    expect(() =>
      loadProfile(writeTemp(withChange("poll_interval_seconds: 5", "poll_interval_seconds: 3601"))),
    ).toThrow(/poll_interval_seconds must be > 0 and <= 3600/);
    // Boundary values are accepted.
    const atBounds = withChange("max_model_steps: 4", "max_model_steps: 20")
      .replace("max_retries: 2", "max_retries: 5")
      .replace("turn_timeout_seconds: 90", "turn_timeout_seconds: 3600")
      .replace("poll_interval_seconds: 5", "poll_interval_seconds: 3600");
    const profile = loadProfile(writeTemp(atBounds));
    expect(profile.runtime.max_model_steps).toBe(20);
  });

  it("validates every merchant_policy field", () => {
    expect(() =>
      loadProfile(
        writeTemp(withChange("min_unit_price_private: 80.00", "min_unit_price_private: -1")),
      ),
    ).toThrow(/min_unit_price_private must be >= 0/);
    expect(() =>
      loadProfile(
        writeTemp(
          withChange(
            "quote_ttl_seconds: 300",
            "max_auto_discount_percent: 120\n  quote_ttl_seconds: 300",
          ),
        ),
      ),
    ).toThrow(/max_auto_discount_percent must be between 0 and 100/);
    expect(() =>
      loadProfile(writeTemp(withChange("quote_ttl_seconds: 300", "quote_ttl_seconds: 0"))),
    ).toThrow(/quote_ttl_seconds must be > 0/);
    expect(() =>
      loadProfile(
        writeTemp(
          withChange(
            "quote_ttl_seconds: 300",
            "quote_ttl_seconds: 300\n  auto_negotiate: yes_please",
          ),
        ),
      ),
    ).toThrow(/auto_negotiate must be a boolean/);
    expect(() =>
      loadProfile(
        writeTemp(
          withChange("quote_ttl_seconds: 300", "quote_ttl_seconds: 300\n  human_review_on: []"),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      loadProfile(
        writeTemp(
          withChange(
            "quote_ttl_seconds: 300",
            "quote_ttl_seconds: 300\n  human_review_on:\n    - ''",
          ),
        ),
      ),
    ).toThrow(/human_review_on must be a list of non-empty strings/);
    expect(() =>
      loadProfile(
        writeTemp(
          withChange("quote_ttl_seconds: 300", "quote_ttl_seconds: 300\n  inventory_source: ''"),
        ),
      ),
    ).toThrow(/inventory_source must be a non-empty string/);
  });

  it("validates model.api against the pi-ai 0.83.0 KnownApi set (fail closed)", () => {
    const good = loadProfile(
      writeTemp(
        withChange(
          "model: fake-merchant-model",
          "model: fake-merchant-model\n  api: openai-completions",
        ),
      ),
    );
    expect(good.model.api).toBe("openai-completions");
    expect(() =>
      loadProfile(
        writeTemp(
          withChange(
            "model: fake-merchant-model",
            "model: fake-merchant-model\n  api: made-up-api",
          ),
        ),
      ),
    ).toThrow(/model\.api must be one of/);
  });

  it("validates model.thinking_level (fail closed)", () => {
    const good = loadProfile(
      writeTemp(
        withChange(
          "model: fake-merchant-model",
          "model: fake-merchant-model\n  thinking_level: high",
        ),
      ),
    );
    expect(good.model.thinking_level).toBe("high");
    expect(() =>
      loadProfile(
        writeTemp(
          withChange(
            "model: fake-merchant-model",
            "model: fake-merchant-model\n  thinking_level: xhigh",
          ),
        ),
      ),
    ).toThrow(/thinking_level must be one of/);
  });
});

describe("base_url security", () => {
  const withCommerceUrl = (url: string): string =>
    VALID_YAML.replace("base_url: http://127.0.0.1:8765", `base_url: ${url}`);
  const withModelUrl = (url: string): string =>
    VALID_YAML.replace(
      "model: fake-merchant-model",
      `model: fake-merchant-model\n  base_url: ${url}`,
    );

  it("allows HTTPS to any host and HTTP only to loopback", () => {
    expect(
      loadProfile(writeTemp(withCommerceUrl("https://api.example.com"))).commerce.base_url,
    ).toBe("https://api.example.com");
    for (const url of ["http://localhost:8765", "http://127.0.0.1:8765", "http://[::1]:8765"]) {
      expect(loadProfile(writeTemp(withCommerceUrl(url))).commerce.base_url).toBe(url);
    }
    for (const url of [
      "http://example.com",
      "http://192.168.1.10",
      "http://localhost.evil.com",
      "http://127.0.0.1.evil.com",
    ]) {
      expect(() => loadProfile(writeTemp(withCommerceUrl(url))), url).toThrow(/cleartext HTTP/);
    }
  });

  it("rejects non-http(s) schemes, userinfo and malformed URLs", () => {
    for (const url of [
      "ftp://example.com",
      "file:///etc/passwd",
      "ws://localhost:1",
      "http://user:pass@localhost:8765",
      "https://user@example.com",
      "not a url",
      "127.0.0.1:8765",
    ]) {
      expect(() => loadProfile(writeTemp(withCommerceUrl(url))), url).toThrow(ProfileError);
    }
  });

  it("applies the same rules to model.base_url", () => {
    expect(
      loadProfile(writeTemp(withModelUrl("https://openai-compatible.example.com/v1"))).model
        .base_url,
    ).toBe("https://openai-compatible.example.com/v1");
    expect(loadProfile(writeTemp(withModelUrl("http://localhost:11434/v1"))).model.base_url).toBe(
      "http://localhost:11434/v1",
    );
    expect(() => loadProfile(writeTemp(withModelUrl("http://192.168.1.20:11434/v1")))).toThrow(
      /cleartext HTTP/,
    );
    expect(() => loadProfile(writeTemp(withModelUrl("gopher://x")))).toThrow(/http or https/);
  });
});

/** 评审项 L6：mkdtemp 目录跟踪清理（此前每次运行在 /tmp 残留）。 */
const tmpDirs: string[] = [];
function trackedMkdtemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}


describe("weixin section", () => {
  const wxYaml = (extra: string): string => `${VALID_YAML}weixin:
${extra}`;
  const wxAllow = (entries: string): string =>
    wxYaml(`  allow_users:
${entries}`);

  it("loads valid weixin section", () => {
    const p = loadProfile(writeTemp(wxAllow("    - wxid_owner\n    - wxid_guest\n")));
    expect(p.weixin?.allow_users).toEqual(["wxid_owner", "wxid_guest"]);
    expect(p.weixin?.base_url).toBeUndefined();
  });

  it("loads base_url override (https)", () => {
    const p = loadProfile(
      writeTemp(wxAllow("    - wxid_owner\n") + "  base_url: https://ilinkai.weixin.qq.com\n"),
    );
    expect(p.weixin?.base_url).toBe("https://ilinkai.weixin.qq.com");
  });

  it("rejects unknown weixin fields (fail-closed)", () => {
    expect(() =>
      loadProfile(writeTemp(wxAllow("    - wxid_owner\n") + "  bot_token: sekrit\n")),
    ).toThrow(/weixin has unknown field "bot_token"/);
  });

  it("rejects non-array allow_users", () => {
    expect(() =>
      loadProfile(writeTemp(`${VALID_YAML}weixin:\n  allow_users: not-a-list\n`)),
    ).toThrow(/weixin.allow_users must be a list/);
  });

  it("rejects empty-string allow_users entries", () => {
    expect(() =>
      loadProfile(writeTemp(`${VALID_YAML}weixin:\n  allow_users:\n    - \n`)),
    ).toThrow(/weixin.allow_users must be a list/);
  });

  it("rejects plain-http base_url (non-loopback)", () => {
    expect(() =>
      loadProfile(writeTemp(wxAllow("    - wxid_owner\n") + "  base_url: http://ilinkai.weixin.qq.com\n")),
    ).toThrow();
  });

  it("omits weixin when absent", () => {
    const p = loadProfile(writeTemp(VALID_YAML));
    expect(p.weixin).toBeUndefined();
  });
});

describe("decision（DeepSeek Harness 运行时插件配置，§6.9）", () => {
  const withModelKey = VALID_YAML.replace(
    "  provider: fake",
    "  provider: deepseek\n  api_key_env: DEEPSEEK_API_KEY",
  );

  it("valid: decision.backend=mock（无需 api_key_env）", () => {
    const p = loadProfile(writeTemp(VALID_YAML + "\ndecision:\n  backend: mock\n  enabled: true\n"));
    expect(p.decision?.backend).toBe("mock");
    expect(p.decision?.enabled).toBe(true);
  });

  it("valid: decision.backend=deepseek + model.api_key_env", () => {
    const p = loadProfile(writeTemp(withModelKey + "\ndecision:\n  backend: deepseek\n"));
    expect(p.decision?.backend).toBe("deepseek");
    expect(p.decision?.enabled).toBeUndefined(); // 缺省 true
  });

  it("rejects: 未知 decision 字段", () => {
    expect(() => loadProfile(writeTemp(VALID_YAML + "\ndecision:\n  backend: mock\n  extra: x\n"))).toThrow(
      /decision has unknown field "extra"/,
    );
  });

  it("rejects: 未知 backend 值", () => {
    expect(() => loadProfile(writeTemp(VALID_YAML + "\ndecision:\n  backend: claude\n"))).toThrow(
      /decision.backend must be one of/,
    );
  });

  it("rejects: enabled 非 boolean", () => {
    expect(() => loadProfile(writeTemp(VALID_YAML + "\ndecision:\n  backend: mock\n  enabled: yes\n"))).toThrow(
      /decision.enabled must be a boolean/,
    );
  });

  it("rejects: backend=deepseek 但缺 model.api_key_env", () => {
    expect(() => loadProfile(writeTemp(VALID_YAML + "\ndecision:\n  backend: deepseek\n"))).toThrow(
      /decision.backend=deepseek requires model.api_key_env/,
    );
  });

  it("allows: backend=deepseek + enabled=false 无 api_key_env（禁用态不要求密钥）", () => {
    const p = loadProfile(writeTemp(VALID_YAML + "\ndecision:\n  backend: deepseek\n  enabled: false\n"));
    expect(p.decision?.enabled).toBe(false);
  });

  it("rejects: buyer 角色配 decision（merchant-only 概念）", () => {
    const buyer = VALID_YAML.replace("role: merchant", "role: buyer");
    expect(() => loadProfile(writeTemp(buyer + "\ndecision:\n  backend: mock\n"))).toThrow(
      /decision is only valid for role=merchant/,
    );
  });
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
