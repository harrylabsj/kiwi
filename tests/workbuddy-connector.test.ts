import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

    expect(output).toContain("validation OK (9 tools)");
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
    expect(server.args).toContain("@harrylabsj/kiwi@0.8.0");
    expect(server.args.join(" ")).toContain("--a2a-timeout-ms 15000");
    expect(server.args.join(" ")).not.toContain("latest");
  });

  it("keeps public v1 credential-free and documents all nine tools", () => {
    const meta = readJson("connector-meta.json");
    const skill = readFileSync(path.join(CONNECTOR, "skills/kiwi-sourcing/SKILL.md"), "utf8");

    expect(meta).not.toHaveProperty("auth_mode");
    expect(meta).toMatchObject({
      source: "kiwi-sourcing",
      type: "mcp",
      version: "1.0.0",
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
