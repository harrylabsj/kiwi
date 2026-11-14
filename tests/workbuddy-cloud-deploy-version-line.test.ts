/**
 * 云端接待部署技能的三条版本线守卫。
 * 线上已发布 0.3.2；活动源 0.2.6 是历史线；专家内嵌 0.3.6 是本地候选。
 * 不允许把活动源 0.2.6 当作平台更新包重发。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buddyRoot = path.join(root, "integrations/hosts/workbuddy/kiwi-merchant-buddy");
const skillRoot = path.join(buddyRoot, "skills/kiwi-cloud-deploy");
const archiveRoot = path.join(buddyRoot, "skills/candidate-archives/kiwi-cloud-deploy/0.3.2");
const expertRoot = path.join(buddyRoot, "experts/kiwi-onboarding-advisor-0.1.9/skills/kiwi-cloud-deploy");

function versionOf(file: string): string {
  const match = /^version:\s*(\S+)$/m.exec(readFileSync(file, "utf8"));
  if (!match?.[1]) throw new Error(`missing version: ${file}`);
  return match[1];
}

describe("kiwi-cloud-deploy 版本线守卫", () => {
  it("活动源、线上归档与专家内嵌分别是 0.2.6 / 0.3.2 / 0.3.6", () => {
    expect(versionOf(path.join(skillRoot, "SKILL.md"))).toBe("0.2.6");
    expect(versionOf(path.join(archiveRoot, "SKILL.md"))).toBe("0.3.2");
    expect(versionOf(path.join(expertRoot, "SKILL.md"))).toBe("0.3.6");
    expect(existsSync(path.join(skillRoot, "VERSION-LINE.md"))).toBe(true);
    const doc = readFileSync(path.join(skillRoot, "VERSION-LINE.md"), "utf8");
    expect(doc).toContain("0.2.6");
    expect(doc).toContain("0.3.2");
    expect(doc).toContain("0.3.6");
    expect(doc).toContain("禁止直接重打包覆盖线上");
  });

  it("发布资产清单把 0.2.5 快照标为已发布 0.3.2 取代，并保留活动源警告", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, "integrations/hosts/workbuddy/release-bundle-manifest.json"), "utf8"),
    ) as { assets: Array<{ id?: string; platform_version?: string; observed_state?: string; source?: string }> };
    const snapshot = manifest.assets.find(
      (asset) => asset.id === "os_1ea25f81ce98fea3" && asset.platform_version === "0.2.5",
    );
    expect(snapshot?.observed_state).toContain("published 0.3.2");
    expect(snapshot?.observed_state).toContain("must not be repackaged");
    const published = manifest.assets.find(
      (asset) => asset.id === "os_1ea25f81ce98fea3" && asset.platform_version === "0.3.2",
    );
    expect(published?.observed_state).toContain("current live standalone skill");
    expect(published?.source).toBe("kiwi-merchant-buddy/skills/candidate-archives/kiwi-cloud-deploy/0.3.2");
  });
});
