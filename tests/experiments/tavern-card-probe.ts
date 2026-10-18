/**
 * 酒馆角色卡 → Perspectra v5 世界包 的能力探针（离线，不建包、不调用模型）。
 *
 * 用法：node --import tsx tests/experiments/tavern-card-probe.ts <角色卡.json>
 *
 * 输入是酒馆导出的角色卡 JSON（V2/V3 顶层对象，或 `chara` 字段的 base64 解码结果）。
 * 输出是这张卡与宿主当前上限的对照：哪些机制能直接承载、哪些会被拒绝、差多少。
 * 上限数字全部来自宿主真实导出（rolePreset 校验器、PHASE8_CONTEXT_PROFILES），不在本脚本里复写。
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { rolePreset, type TextRule } from '../../packages/provider-chat/src/preset.ts'
import { PHASE8_CONTEXT_PROFILES } from '../../packages/contracts/src/phase8-registries.ts'

const KIB = 1024

interface ForeignRegex {
  readonly scriptName?: string
  readonly findRegex?: string
  readonly replaceString?: string
  readonly disabled?: boolean
  readonly markdownOnly?: boolean
  readonly promptOnly?: boolean
  readonly placement?: number[]
}
interface CardEntry {
  readonly comment?: string
  readonly content?: string
  readonly keys?: string[]
  readonly constant?: boolean
  readonly enabled?: boolean
}
interface CardData {
  readonly name?: string
  readonly creator?: string
  readonly character_version?: string
  readonly tags?: string[]
  readonly alternate_greetings?: string[]
  readonly first_mes?: string
  readonly extensions?: { readonly world?: string; readonly regex_scripts?: ForeignRegex[]; readonly tavern_helper?: { readonly scripts?: { name?: string; content?: string }[] } }
  readonly character_book?: { readonly name?: string; readonly entries?: CardEntry[] }
}

const argument = process.argv[2]
if (argument === undefined) throw new TypeError('用法：tavern-card-probe <角色卡.json>')

const raw = JSON.parse(readFileSync(resolve(argument), 'utf8')) as Record<string, unknown>
// 允许直接喂 chara/ccv3 文本块内容：既接受已解码 JSON，也接受 base64。
const card = (typeof raw.chara === 'string' ? JSON.parse(Buffer.from(raw.chara, 'base64').toString('utf8')) : raw) as CardData
const data: CardData = (card as { data?: CardData }).data ?? card
const entries = data.character_book?.entries ?? []
const regexes = data.extensions?.regex_scripts ?? []

const line = (label: string, value: string): void => { console.log(`  ${label.padEnd(26, '　')} ${value}`) }
const verdict = (ok: boolean, label: string, detail: string): void => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  if (detail.length > 0) console.log(`     ${detail}`)
}

console.log(`\n文件：${basename(argument)}`)
console.log(`卡名：${data.name ?? '(无)'}  作者：${data.creator ?? '(无)'}  版本：${data.character_version ?? '(无)'}`)

// ── 1. 世界书 ────────────────────────────────────────────────
console.log('\n【世界书 → documents.json / cognition.json】')
const totalCharacters = entries.reduce((sum, entry) => sum + (entry.content?.length ?? 0), 0)
const withKeys = entries.filter(entry => (entry.keys ?? []).length > 0).length
line('词条数', String(entries.length))
line('正文合计', `${(totalCharacters / KIB / KIB).toFixed(2)} MB 字符`)
line('常驻 / 关键词触发', `${entries.filter(entry => entry.constant).length} / ${withKeys}`)
line('最大单条', `${Math.max(0, ...entries.map(entry => entry.content?.length ?? 0))} 字符`)
const MAXIMUM_DOCUMENTS = 512 // packages/world-pack/src/schema.ts
verdict(entries.length <= MAXIMUM_DOCUMENTS, `documents.json 容量（上限 ${MAXIMUM_DOCUMENTS}）`, entries.length <= MAXIMUM_DOCUMENTS ? '' : `超出 ${entries.length - MAXIMUM_DOCUMENTS} 条，需要合并或裁剪`)

// 每回合能进上下文的知识条数取宿主上下文档位，不在包内声明。
const profiles = PHASE8_CONTEXT_PROFILES.map(profile => `${profile.profileId}=${profile.recallResults}`).join(' / ')
line('每回合召回上限', profiles)
line('召回策略来源', '宿主选项（包内无可声明的关键词表，ADR-0088/0090 状态 Proposed）')

// ── 2. 正则脚本 → 文本规则 ───────────────────────────────────
console.log('\n【正则脚本 → 预设文本规则】')
// 按 packages/provider-chat/process/tavern-import.ts 的既有映射复算：promptOnly 决定模型读到的，
// markdownOnly 决定玩家看到的；一条源规则可能因此拆成两条宿主规则。
const MAXIMUM_REPLACEMENT = 4000 // packages/provider-chat/src/preset.ts
const rules: TextRule[] = []
const oversize: string[] = []
const skipped: string[] = []
for (const [index, rule] of regexes.entries()) {
  const name = rule.scriptName ?? `regex-${index}`
  const stages = new Set<'input' | 'history' | 'display'>()
  const placement = Array.isArray(rule.placement) ? rule.placement.map(Number) : []
  if (rule.promptOnly === true) { if (placement.includes(1)) stages.add('input'); if (placement.includes(2)) stages.add('history') }
  if (rule.markdownOnly === true) stages.add('display')
  if (stages.size === 0) { skipped.push(`${name}（既不改提示也不改展示）`); continue }
  const replacement = rule.replaceString ?? ''
  if (replacement.length > MAXIMUM_REPLACEMENT) oversize.push(`${name}（${replacement.length} 字符）`)
  for (const stage of stages) {
    rules.push({ id: `${index}-${stage}`, name: `${name} · ${stage}`, enabled: rule.disabled !== true, stage, target: 'both',
      pattern: (rule.findRegex ?? '').slice(0, 1000) || 'x', flags: 'g', replacement: replacement.slice(0, MAXIMUM_REPLACEMENT) })
  }
}
line('源脚本数', String(regexes.length))
line('展开后规则数', String(rules.length))
line('替换文本超长', oversize.length === 0 ? '无' : oversize.join('、'))
if (skipped.length > 0) line('无作用被跳过', skipped.join('、'))
try {
  const accepted = rolePreset({ textRules: rules })
  verdict(true, '宿主校验器接受', `实际通过 ${accepted.textRules?.length ?? 0} 条`)
} catch (error) {
  verdict(false, '宿主校验器拒绝', error instanceof Error ? error.message : String(error))
}

// ── 3. 开局与角色 ────────────────────────────────────────────
console.log('\n【开局 / 角色】')
line('first_mes', `${(data.first_mes ?? '').length} 字符`)
line('alternate_greetings', `${(data.alternate_greetings ?? []).length} 条`)
line('aid 角色词条', `${entries.filter(entry => /\[(Pro|Lite)\]/.test(entry.comment ?? '')).length} 条`)
line('开局机制', '宿主无多开局概念：player-slots 恰好 1 个，起点由创世决定；既有做法是活动 operations 菜单')

// ── 4. 脚本与变量 ────────────────────────────────────────────
console.log('\n【MVU 脚本 / 变量】')
const scripts = data.extensions?.tavern_helper?.scripts ?? []
for (const script of scripts) line(script.name ?? '(匿名)', `${((script.content ?? '').length / KIB).toFixed(1)} KB`)
line('模型写变量通道', '无：变量只能由作者脚本 initialize/applyPatch 裁定，模型侧只读')

console.log('')
