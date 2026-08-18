/**
 * kiwi-dsh-plugin prepack 校验门（npm run validate / prepack）。
 * 纯 Node，无 dsh 依赖：检查 manifest 形态、运行时文件齐备、patch 行、宿主导出、技能正文。
 */
import { readFileSync, existsSync } from 'node:fs'

let ok = true
const check = (cond, msg) => {
  if (!cond) {
    ok = false
    console.error('✗', msg)
  }
}

// 1. package.json：dsh.bundle.patch + main
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
check(pkg.dsh?.bundle?.patch, 'package.json dsh.bundle.patch 缺失')
check(pkg.main === 'lib/index.js', 'main 必须是 lib/index.js')
check(pkg.files?.includes('cordis.patch.yml'), 'files 未包含 cordis.patch.yml')

// 2. 运行时文件齐备
for (const f of [
  'cordis.patch.yml',
  'lib/index.js',
  'lib/index.d.ts',
  'skills/kiwi-buyer/SKILL.md',
  'README.md',
]) {
  check(existsSync(new URL(`../${f}`, import.meta.url)), `缺失文件 ${f}`)
}

// 3. patch 含 mcp-kiwi + kiwi-dsh-plugin 两行
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
check(patch.includes("name: '@deepseek-ai/dsh-mcp-client'"), "patch 缺 mcp-client 行（@deepseek-ai/dsh-mcp-client）")
check(patch.includes('serverName: kiwi'), 'patch 缺 serverName: kiwi')
check(patch.includes("name: '@harrylabsj/kiwi-dsh-plugin'"), 'patch 缺本插件行（kiwi-dsh-plugin）')

// 4. 宿主插件导出（name / inject / apply）
const mod = await import(new URL('../lib/index.js', import.meta.url))
check(mod.name === 'kiwi-dsh-plugin', 'lib/index.js 导出的 name 必须是 kiwi-dsh-plugin')
check(Array.isArray(mod.inject) && mod.inject.includes('skills'), 'lib/index.js 必须 inject skills')
check(typeof mod.apply === 'function', 'lib/index.js 必须导出 apply')

// 5. 技能正文非空（剥离 frontmatter 后）
const md = readFileSync(new URL('../skills/kiwi-buyer/SKILL.md', import.meta.url), 'utf8')
const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
check(body.trim().length > 200, 'SKILL.md 正文过短（剥离 frontmatter 后 <200 字符）')

if (ok) {
  console.log('✓ kiwi-dsh-plugin validate ok')
  process.exit(0)
}
process.exit(1)
