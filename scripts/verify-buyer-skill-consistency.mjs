#!/usr/bin/env node
/**
 * 买方技能副本一致性校验（双来源搜索 工作包 B5）。
 *
 * 背景：买方采购规则在多个宿主包里各有一份副本（主仓 `skills/kiwi-buyer/`、
 * Hermes 插件仓、WorkBuddy 专家包），**没有任何自动同步**（设计文档 §16.1 已指出）。
 * 双来源搜索引入了一批必须两端一致的语义（来源分区、`network_search` 状态映射、
 * 价格类型词表、外部候选边界），一旦只改其中一份就会静默分叉。
 *
 * 本校验做双向断言：
 *   1) 已支持双来源的副本必须含共享语义标记（按语言分别断言）；
 *   2) 尚未支持的副本必须显式标注「尚未支持双来源搜索」，且不得使用新词表；
 *   3) 未登记的买方技能副本（新增文件忘了纳入）直接失败。
 *
 * 跨仓副本（Hermes 插件仓）在本机存在时一并校验，缺席时跳过并提示——CI 的干净
 * 检出只覆盖仓内副本。telemetry 最小化：本校验不联网、不上报。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`buyer-skill FAIL: ${message}`);
};

/** 双来源共享语义标记（语言中立部分：状态与价格类型词表必须逐字一致）。 */
const SHARED_TOKENS = [
  "Kiwi Network",
  "network_search",
  "completed",
  "no_match",
  "merchant_listed_price",
  "page_reference",
  "merchant_quoted",
  "to_be_quoted",
];

/** 已支持双来源的副本：来源分区 + 状态映射 + 价格类型词表。 */
const DUAL_SOURCE_FILES = [
  { path: "skills/kiwi-buyer/SKILL.md", lang: "zh" },
  {
    path: "integrations/hosts/workbuddy/kiwi-procurement-expert/agents/kiwi-procurement.md",
    lang: "zh",
  },
  {
    path: "integrations/hosts/workbuddy/kiwi-procurement-expert/skills/kiwi-source-and-quote/SKILL.md",
    lang: "zh",
  },
  // 跨仓（本机存在时校验；Hermes 插件仓与本仓同目录层级）。
  { path: "../hermes-plugin-kiwi/skills/kiwi-buyer/SKILL.md", lang: "en", optional: true },
  { path: "../hermes-plugin-kiwi/skills/kiwi-buyer/SKILL.zh-CN.md", lang: "zh", optional: true },
];

/** 已支持双来源、但只承担边界规则的副本（不做来源分区展示）。 */
const BOUNDARY_FILES = [
  {
    path: "integrations/hosts/workbuddy/kiwi-procurement-expert/skills/kiwi-compare-and-negotiate/SKILL.md",
    require: ["merchant_listed_price", "page_reference", "to_be_quoted", "kiwi_negotiate"],
  },
  {
    path: "integrations/hosts/workbuddy/kiwi-procurement-expert/skills/kiwi-agreement-handoff/SKILL.md",
    require: ["互联网电商", "Kiwi 商家身份"],
  },
];

/** 尚未支持双来源的副本：必须显式标注，且不得使用新词表。 */
const PENDING_FILES = [
  "integrations/hosts/deepseek-harness/SKILL.md",
  "integrations/plugins/kiwi-dsh-plugin/skills/kiwi-buyer/SKILL.md",
];

/** 语言相关的措辞标记（展示名称与外部来源表述）。 */
const LANGUAGE_TOKENS = {
  zh: ["互联网电商", "网络内商家"],
  en: ["Internet e-commerce", "internet"],
};

const PENDING_MARKER = "尚未支持双来源搜索";

const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const descriptionOf = (entry) => (typeof entry === "string" ? entry : entry.path);

for (const entry of DUAL_SOURCE_FILES) {
  const relative = descriptionOf(entry);
  if (!existsSync(path.join(root, relative))) {
    if (entry.optional === true) {
      console.log(`buyer-skill SKIP: ${relative}（本机不存在，跳过跨仓副本）`);
      continue;
    }
    fail(`${relative} 不存在`);
    continue;
  }
  const text = read(relative);
  for (const token of [...SHARED_TOKENS, ...(LANGUAGE_TOKENS[entry.lang] ?? [])]) {
    if (!text.includes(token)) fail(`${relative} 缺少双来源语义标记：${token}`);
  }
}

for (const entry of BOUNDARY_FILES) {
  if (!existsSync(path.join(root, entry.path))) {
    fail(`${entry.path} 不存在`);
    continue;
  }
  const text = read(entry.path);
  for (const token of entry.require) {
    if (!text.includes(token)) fail(`${entry.path} 缺少边界规则标记：${token}`);
  }
}

for (const relative of PENDING_FILES) {
  if (!existsSync(path.join(root, relative))) {
    fail(`${relative} 不存在`);
    continue;
  }
  const text = read(relative);
  if (!text.includes(PENDING_MARKER)) {
    fail(`${relative} 未标注「${PENDING_MARKER}」——更新它或显式标注为未支持`);
  }
  for (const token of ["network_search", "merchant_listed_price"]) {
    if (text.includes(token)) {
      fail(`${relative} 标为未支持双来源，却已使用新词表：${token}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`buyer-skill consistency FAILED: ${failures.length} 项`);
  process.exit(1);
}
console.log(
  `buyer-skill consistency OK: ${DUAL_SOURCE_FILES.length} 个双来源副本 + ` +
    `${BOUNDARY_FILES.length} 个边界副本 + ${PENDING_FILES.length} 个未支持副本`,
);
