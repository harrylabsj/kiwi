import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_PROTOCOL_VERSIONS } from "../src/mcp/types.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONNECTOR = path.join(ROOT, "integrations/hosts/workbuddy/kiwi-sourcing");

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(CONNECTOR, file), "utf8")) as Record<string, unknown>;

describe("WorkBuddy kiwi-sourcing connector", () => {
  it("passes the standalone release validator", () => {
    const output = execFileSync(process.execPath, [path.join(CONNECTOR, "scripts/validate.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
    });

    expect(output).toContain("validation OK (13 tools)");
  });

  it("uses one local stdio server with bounded timeouts and a pinned Kiwi release", () => {
    const config = readJson("mcp.json") as {
      mcpServers: Record<
        string,
        {
          type: string;
          command: string;
          args: string[];
          runtime: { type: string; version: string };
          timeout: number;
        }
      >;
    };
    const entries = Object.entries(config.mcpServers);

    expect(entries).toHaveLength(1);
    const [name, server] = entries[0]!;
    expect(name).toBe("kiwi-sourcing");
    expect(server).toMatchObject({
      type: "stdio",
      command: "npx",
      runtime: { type: "node", version: "22" },
      timeout: 30_000,
    });
    expect(server.args).toContain("@harrylabsj/kiwi@0.12.3");
    expect(server.args.join(" ")).toContain("--a2a-timeout-ms 15000");
    expect(server.args).not.toContain("--prefer-online");
  });

  it.each(["latest", "^0.12.3", "~0.12.3", "0.12", "01.12.3", "0.12.3-beta.1", "duplicate"])(
    "rejects floating or non-stable package spec %s in the release validator",
    (version) => {
      const directory = mkdtempSync(path.join(tmpdir(), "kiwi-connector-validator-"));
      try {
        const connector = path.join(directory, "integrations/hosts/workbuddy/kiwi-sourcing");
        mkdirSync(path.dirname(connector), { recursive: true });
        cpSync(CONNECTOR, connector, { recursive: true });
        writeFileSync(path.join(directory, "package.json"), "{}\n");
        const mcp = JSON.parse(readFileSync(path.join(connector, "mcp.json"), "utf8"));
        const args: string[] = mcp.mcpServers["kiwi-sourcing"].args;
        if (version === "duplicate") args.push("@harrylabsj/kiwi@0.12.3");
        else args[args.indexOf("@harrylabsj/kiwi@0.12.3")] = `@harrylabsj/kiwi@${version}`;
        writeFileSync(path.join(connector, "mcp.json"), JSON.stringify(mcp));
        const result = spawnSync(process.execPath, [path.join(connector, "scripts/validate.mjs")], { encoding: "utf8" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("明确 stable semver");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps public v1 credential-free and documents all thirteen tools", () => {
    const meta = readJson("connector-meta.json");
    const skill = readFileSync(path.join(CONNECTOR, "skills/kiwi-sourcing/SKILL.md"), "utf8");

    expect(meta).not.toHaveProperty("auth_mode");
    expect(skill).toMatch(/^version: 1\.0\.2$/m);
    expect(meta).toMatchObject({
      source: "kiwi-sourcing",
      type: "mcp",
      version: "1.0.2",
      minWorkbuddyVersion: "5.0.0",
    });
    for (const tool of [
      "kiwi_search",
      "kiwi_request_quotes",
      "kiwi_get_task",
      "kiwi_negotiate",
      "kiwi_accept_agreement",
      "kiwi_get_agreement",
      "kiwi_handoff",
      "kiwi_approve",
      "kiwi_reject",
      "kiwi_follow_merchant",
      "kiwi_unfollow_merchant",
      "kiwi_list_follows",
      "kiwi_get_follow_updates",
    ]) {
      expect(skill).toContain(tool);
    }
    expect(skill).toContain("不创建订单、不支付、不锁库存");
    expect(skill).toContain("最多选择 3 家");
  });

  it("keeps the WorkBuddy handshake fixture on a supported stable MCP version", () => {
    const messages = readFileSync(
      path.join(CONNECTOR, "fixtures/initialize-tools-list.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params?: { protocolVersion?: string } });

    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(MCP_PROTOCOL_VERSIONS).toContain(messages[0]?.params?.protocolVersion);
  });
});
