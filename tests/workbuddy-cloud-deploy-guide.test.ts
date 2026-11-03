/**
 * 云端部署交付指引的链接口径（2026-10-31 实测修复的回归钉）。
 *
 * 背景：商家打开带分享码的部署根路径得到源站 404——根路径没有页面，商家
 * 工作台在 `/merchant/`（登录页 `/admin/login`）。交付指引是商家拿到链接的
 * 来源（kiwi-cloud-deploy 技能第 2 步与方案 B 提示词第 6 步），必须写全
 * 工作台路径；本文件钉住该口径，防止指引文案回归成裸地址。
 *
 * 边界：`experts/` 与 `skills/candidate-archives/` 下是已送审候选的内容寻址
 * 归档（有逐文件 SHA-256 清单），不在本测试范围、也不得改动；本文件只校验
 * canonical 技能源（`skills/kiwi-cloud-deploy/`）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const buddyRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../integrations/hosts/workbuddy/kiwi-merchant-buddy",
);
const skillDir = path.join(buddyRoot, "skills", "kiwi-cloud-deploy");

describe("云端部署交付指引（kiwi-cloud-deploy）的商家入口口径", () => {
  const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const fallback = readFileSync(path.join(skillDir, "references", "fallback-prompt.md"), "utf8");

  it("首次发布步骤：转述给商家的入口写全工作台路径，并说明根路径 404", () => {
    // 交付时刻（第 2 步）必须给出带路径的入口，而不是裸公网地址。
    expect(skill).toContain("<公网地址>/merchant/");
    expect(skill).toContain("<公网地址>/admin/login");
    // 根路径无页面的事实要写明（实测 404），避免指引退回裸地址。
    expect(skill).toContain("源站返回 404");
    expect(skill).toContain("不得把裸地址或平台分享链接原样当作商家入口");
  });

  it("分享码边界：保留参数通过网关，且不得假定源站能看到/回显分享码", () => {
    expect(skill).toContain("保留该参数");
    expect(skill).toContain("源站看不到分享码、也不得回显");
  });

  it("常见错误清单包含裸地址当入口的反例", () => {
    expect(skill).toContain('把裸公网地址或平台分享链接原样当"工作台链接"交给商家');
  });

  it("方案 B 提示词的交付步骤指向 /admin/login 与 /merchant/（既有口径不回归）", () => {
    expect(fallback).toContain("`<公网链接>/admin/login`");
    expect(fallback).toContain("`<公网链接>/merchant/`");
  });
});
