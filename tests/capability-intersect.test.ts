/**
 * Capability intersection 测试（基线 §3.1 / §33）：
 *  - 从双方 supportedInterfaces 选共同 binding，不得硬编码单一 binding；
 *  - core binding 版本兼容精确匹配，未知版本 fail-closed（§4.6）；
 *  - 未知 binding 不拒绝但不选择（§26）；
 *  - 无共同可协商 binding 时 requireCompatibleCapabilities 抛
 *    capability_incompatible（§32）。
 */
import { describe, expect, it } from "vitest";
import { validateAgentCard } from "../src/discovery/agent-card/index.js";
import {
  CapabilityError,
  intersectCapabilities,
  requireCompatibleCapabilities,
} from "../src/discovery/capability/index.js";
import type { AgentInterface } from "../src/discovery/agent-card/index.js";

function iface(
  protocolBinding: string,
  protocolVersion: string,
  url = "https://remote.example/a2a",
): AgentInterface {
  return { url, protocolBinding, protocolVersion };
}

function remoteCard(interfaces: AgentInterface[]): Record<string, unknown> {
  return {
    name: "Remote Agent",
    description: "Remote counterparty",
    provider: { organization: "Remote Org" },
    version: "1.0.0",
    supportedInterfaces: interfaces,
  };
}

describe("共同 binding 选择（§3.1）", () => {
  it("selects the single shared JSONRPC binding", () => {
    const local = [iface("JSONRPC", "1.0", "https://local.example/a2a")];
    const remote = [iface("JSONRPC", "1.0", "https://remote.example/a2a")];
    const result = intersectCapabilities(local, remote);
    expect(result.compatible).toBe(true);
    expect(result.selected).toMatchObject({
      protocolBinding: "JSONRPC",
      url: "https://remote.example/a2a",
    });
    expect(result.candidates).toHaveLength(1);
  });

  it("does not hardcode a single binding: picks HTTP+JSON when that is the only common core binding", () => {
    const local = [iface("HTTP+JSON", "1.0")];
    const remote = [iface("HTTP+JSON", "1.0")];
    const result = intersectCapabilities(local, remote);
    expect(result.selected?.protocolBinding).toBe("HTTP+JSON");
  });

  it("does not hardcode a single binding: picks GRPC when that is the only common core binding", () => {
    const local = [iface("GRPC", "1.0")];
    const remote = [iface("GRPC", "1.0")];
    const result = intersectCapabilities(local, remote);
    expect(result.selected?.protocolBinding).toBe("GRPC");
  });

  it("prefers JSONRPC over GRPC over HTTP+JSON among several shared bindings", () => {
    const local = [iface("HTTP+JSON", "1.0"), iface("JSONRPC", "1.0"), iface("GRPC", "1.0")];
    const remote = [iface("GRPC", "1.0"), iface("HTTP+JSON", "1.0"), iface("JSONRPC", "1.0")];
    const result = intersectCapabilities(local, remote);
    expect(result.selected?.protocolBinding).toBe("JSONRPC");
    expect(result.candidates.map((c) => c.protocolBinding)).toEqual([
      "JSONRPC",
      "GRPC",
      "HTTP+JSON",
    ]);
  });

  it("honors a custom preference order", () => {
    const local = [iface("JSONRPC", "1.0"), iface("GRPC", "1.0")];
    const remote = [iface("GRPC", "1.0"), iface("JSONRPC", "1.0")];
    const result = intersectCapabilities(local, remote, {
      preference: ["GRPC", "JSONRPC"],
    });
    expect(result.selected?.protocolBinding).toBe("GRPC");
  });

  it("accepts an AgentCard on either side", () => {
    const localCard = validateAgentCard(remoteCard([iface("JSONRPC", "1.0")]));
    const remote = [iface("JSONRPC", "1.0")];
    const result = intersectCapabilities(localCard, remote);
    expect(result.selected?.protocolBinding).toBe("JSONRPC");
  });

  it("matches when one side declares the same binding twice and one version aligns", () => {
    const local = [iface("JSONRPC", "1.0")];
    const remote = [iface("JSONRPC", "0.9"), iface("JSONRPC", "1.0")];
    const result = intersectCapabilities(local, remote);
    expect(result.compatible).toBe(true);
    expect(result.selected?.protocolBinding).toBe("JSONRPC");
  });
});

describe("版本兼容（fail-closed）", () => {
  it("marks a version mismatch as incompatible", () => {
    const local = [iface("JSONRPC", "1.0")];
    const remote = [iface("JSONRPC", "2.0")];
    const result = intersectCapabilities(local, remote);
    expect(result.compatible).toBe(false);
    expect(result.selected).toBeUndefined();
    expect(result.incompatible).toEqual([
      expect.objectContaining({ binding: "JSONRPC", localVersion: "1.0", remoteVersion: "2.0" }),
    ]);
  });

  it("treats a missing protocolVersion on one side as incompatible", () => {
    const local = [iface("JSONRPC", "1.0")];
    // Simulate a malformed/legacy remote that omitted protocolVersion (untrusted
    // input path — intersection is defensive even though validateAgentCard requires it).
    const remote = [
      { url: "https://remote.example/a2a", protocolBinding: "JSONRPC" },
    ] as AgentInterface[];
    const result = intersectCapabilities(local, remote);
    expect(result.compatible).toBe(false);
    expect(result.incompatible[0]?.reason).toMatch(/missing/i);
  });

  it("supports a custom versionMatch policy", () => {
    // 模拟 semver 前缀策略：local "1.0" 接受 remote "1.0.x"。
    const local = [iface("JSONRPC", "1.0")];
    const remote = [iface("JSONRPC", "1.0.3")];
    const result = intersectCapabilities(local, remote, {
      versionMatch: (l, r) => l !== undefined && r !== undefined && r.startsWith(l),
    });
    expect(result.compatible).toBe(true);
  });
});

describe("未知 binding（不拒绝但不选择）", () => {
  it("reports a shared unknown binding but never selects it", () => {
    const local = [iface("https://vendor.example/bindings/custom/1.0", "1.0")];
    const remote = [iface("https://vendor.example/bindings/custom/1.0", "1.0")];
    const result = intersectCapabilities(local, remote);
    expect(result.unknownShared).toEqual(["https://vendor.example/bindings/custom/1.0"]);
    expect(result.selected).toBeUndefined();
    expect(result.compatible).toBe(false);
  });

  it("selects a core binding even when an unknown binding is also shared", () => {
    const local = [
      iface("JSONRPC", "1.0"),
      iface("https://vendor.example/bindings/custom/1.0", "1.0"),
    ];
    const remote = [
      iface("https://vendor.example/bindings/custom/1.0", "1.0"),
      iface("JSONRPC", "1.0"),
    ];
    const result = intersectCapabilities(local, remote);
    expect(result.selected?.protocolBinding).toBe("JSONRPC");
    expect(result.unknownShared).toHaveLength(1);
  });
});

describe("单方 binding 与无共同 binding", () => {
  it("reports one-sided bindings for diagnostics", () => {
    const local = [iface("JSONRPC", "1.0")];
    const remote = [iface("HTTP+JSON", "1.0"), iface("GRPC", "1.0")];
    const result = intersectCapabilities(local, remote);
    expect(result.compatible).toBe(false);
    expect(result.oneSided.sort()).toEqual(["GRPC", "HTTP+JSON", "JSONRPC"]);
  });

  it("requireCompatibleCapabilities throws capability_incompatible when nothing negotiates", () => {
    const local = [iface("JSONRPC", "1.0")];
    const remote = [iface("GRPC", "1.0")];
    expect(() => requireCompatibleCapabilities(local, remote)).toThrow(CapabilityError);
  });

  it("requireCompatibleCapabilities returns the intersection when compatible", () => {
    const local = [iface("JSONRPC", "1.0")];
    const remote = [iface("JSONRPC", "1.0")];
    const result = requireCompatibleCapabilities(local, remote);
    expect(result.selected?.protocolBinding).toBe("JSONRPC");
  });
});
