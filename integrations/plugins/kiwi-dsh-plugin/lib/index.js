/**
 * kiwi-dsh-plugin host side（Cordis 插件）—— 注册 kiwi-buyer SKILL。
 *
 * MCP 连接（kiwi-buyer-mcp，9 个 Sourcing Tools → mcp__kiwi__*）由 cordis.patch.yml
 * 的 `mcp-kiwi` 行负责（@deepseek-ai/dsh-mcp-client 静态配置，零动态值：主从
 * kiwi mcp serve 的默认路径/env 解析 —— KIWI_MCP_DB / KIWI_PRINCIPAL /
 * KIWI_BUYER_AGENT，见 kiwi `src/mcp/cli.ts`）。本插件只负责 skill。
 *
 * 纯 ESM JS、零运行时依赖：只 import node 内置模块（不 import @deepseek-ai/*，
 * 避免 ESM realpath 解析问题）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Cordis 插件诊断名。 */
export const name = 'kiwi-dsh-plugin'
/** 需要的服务：ctx.skills（技能注册表）。 */
export const inject = ['skills']

const SKILL_DIR = fileURLToPath(new URL('../skills/kiwi-buyer', import.meta.url))
const SKILL_PATH = fileURLToPath(new URL('../skills/kiwi-buyer/SKILL.md', import.meta.url))

/**
 * 剥离前导 YAML frontmatter（`---` 包裹块）。SKILL.md 的 frontmatter 供人读；
 * SkillDefinition.content 只取正文。
 */
function stripFrontmatter(text) {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? text.slice(match[0].length) : text
}

/** 加载 kiwi-buyer skill（fail-closed：缺失抛错，prepack validate 也会拦截）。 */
function loadSkill() {
  if (!existsSync(SKILL_PATH)) {
    throw new Error(`kiwi-dsh-plugin: skills/kiwi-buyer/SKILL.md not found (${SKILL_PATH})`)
  }
  const raw = readFileSync(SKILL_PATH, 'utf8')
  return {
    name: 'kiwi-buyer',
    description:
      'Kiwi Sourcing & Negotiation Kit —— 采购/购买/购物一般商品（非餐饮、非外卖、非生鲜）时使用：找商家/供应商、询价、比价、还价、问交期/MOQ。经 mcp__kiwi__* 的 9 个工具完成跨商家发现 → 询价 → 磋商 → 非绑定协议 → handoff。',
    whenToUse: '用户表达采购意图（买 / 找供应商 / 询价 / 比价 / 还价 / 交期 / MOQ）时',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: 'kiwi-dsh-plugin',
    content: stripFrontmatter(raw),
    path: SKILL_PATH,
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  }
}

/**
 * apply(ctx)：注册 SkillProvider（数据驱动，单一 SKILL.md）。
 * 返回 registerProvider 的 disposer → Cordis 自动在卸载时清理。
 */
export function apply(ctx) {
  const skill = loadSkill()
  return ctx.skills.registerProvider(() => ({
    name: 'kiwi-dsh-plugin',
    async list() {
      return [
        {
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          invocation: skill.invocation,
          source: skill.source,
          provider: skill.provider,
          rank: 1,
          locator: skill.name,
          path: skill.path,
          resourceBase: skill.resourceBase,
        },
      ]
    },
    async get() {
      return skill
    },
  }))
}
