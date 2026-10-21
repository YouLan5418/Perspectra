/**
 * 酒馆角色卡 → Perspectra v5 世界包 的能力探针（离线，不建包、不调用模型）。
 *
 * 用法：node --import tsx tests/experiments/tavern-card-probe.ts <角色卡.png|json>
 *
 * 输入是酒馆角色卡 PNG，或已解码的卡 JSON（V2/V3 顶层对象）。
 * 输出是这张卡与宿主当前上限的对照：哪些机制能直接承载、哪些会被拒绝、差多少。
 * 上限数字优先从宿主源码导入；无法导入的常量在注释里标明出处，不在本脚本里另立一套。
 */
import { basename, resolve } from 'node:path'
import { rolePreset, type TextRule } from '../../packages/provider-chat/src/preset.ts'
import { CONTEXT_PROFILES } from '@harness-world/contracts'
import { readTavernCard } from './tavern-black-shores-slice.ts'

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
interface CardScript { readonly name?: string; readonly content?: string }
interface CardData {
  readonly name?: string
  readonly creator?: string
  readonly character_version?: string
  readonly tags?: string[]
  readonly alternate_greetings?: string[]
  readonly first_mes?: string
  readonly extensions?: { readonly world?: string; readonly regex_scripts?: ForeignRegex[]
    readonly tavern_helper?: { readonly scripts?: CardScript[] } }
  readonly character_book?: { readonly name?: string; readonly entries?: CardEntry[] }
}

const argument = process.argv[2]
if (argument === undefined) throw new TypeError('用法：tavern-card-probe <角色卡.png|json>')

const card = readTavernCard(resolve(argument)) as unknown as CardData & { data?: CardData }
const data: CardData = card.data ?? card
const entries = data.character_book?.entries ?? []
const regexes = data.extensions?.regex_scripts ?? []
const scripts = data.extensions?.tavern_helper?.scripts ?? []

const line = (label: string, value: string): void => { console.log(`  ${label.padEnd(26, '　')} ${value}`) }
const verdict = (ok: boolean, label: string, detail: string): void => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  if (detail.length > 0) console.log(`     ${detail}`)
}

/** 顶层键：从一个 `z.object({...})` 字面量里按花括号深度取第一层。 */
function topLevelKeys(source: string, declaration = 'Schema'): string[] | undefined {
  const start = source.search(new RegExp(`(?:export\\s+)?const ${declaration}\\s*=\\s*z\\.object\\(\\{`))
  if (start < 0) return undefined
  const body = source.slice(source.indexOf('{', start) + 1)
  const keys: string[] = []
  let depth = 0
  for (const row of body.split('\n')) {
    const text = row.trim()
    if (depth === 0 && text.startsWith('})')) break
    if (depth === 0) {
      const match = /^([^\s:/]+):\s*/.exec(text)
      if (match?.[1] !== undefined && !match[1].startsWith('//')) keys.push(match[1])
    }
    depth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length
    if (depth < 0) break
  }
  return keys.length > 0 ? keys : undefined
}

console.log(`\n文件：${basename(argument)}`)
console.log(`卡名：${data.name ?? '(无)'}  作者：${data.creator ?? '(无)'}  版本：${data.character_version ?? '(无)'}`)

// ── 1. 世界书 ────────────────────────────────────────────────
// documents 与文件数上限见 packages/world-pack/src/schema.ts（MAX_DOCUMENTS / MAX_EXPLICIT_FILES），
// 交付预算与整条投递规则见 desktop/host/pack-knowledge.ts（maximumCharacters ≤ 65536，整条超出即跳过）。
console.log('\n【世界书 → documents.json + knowledge.json】')
const size = (entry: CardEntry): number => entry.content?.length ?? 0
const enabled = entries.filter(entry => entry.enabled !== false)
const constantCharacters = enabled.filter(entry => entry.constant).reduce((sum, entry) => sum + size(entry), 0)
line('词条数', String(entries.length))
line('正文合计', `${(entries.reduce((sum, entry) => sum + size(entry), 0) / KIB / KIB).toFixed(2)} MB 字符`)
line('常驻 / 关键词触发', `${entries.filter(entry => entry.constant).length} / ${entries.filter(entry => (entry.keys ?? []).length > 0).length}`)
line('最大单条', `${Math.max(0, ...entries.map(size))} 字符`)

const MAXIMUM_DOCUMENTS = 4096, MAXIMUM_DELIVERY = 65536, MAXIMUM_KEYWORDS = 256
const MAXIMUM_KEYWORD_LENGTH = 512, MAXIMUM_MARKDOWN_BYTES = 256 * KIB
verdict(entries.length <= MAXIMUM_DOCUMENTS, `documents 容量（上限 ${MAXIMUM_DOCUMENTS}）`,
  entries.length <= MAXIMUM_DOCUMENTS ? '' : `超出 ${entries.length - MAXIMUM_DOCUMENTS} 条，需要合并或裁剪`)

// 知识条目整条投递、不截断：超过投递预算的条目永远进不了上下文，只能拆成多段。
const undeliverable = entries.filter(entry => size(entry) > MAXIMUM_DELIVERY)
verdict(undeliverable.length === 0, `单条可整条投递（上限 ${MAXIMUM_DELIVERY} 字符）`,
  undeliverable.length === 0 ? '' : `${undeliverable.length} 条永远交付不了，需拆分：${undeliverable.slice(0, 4).map(entry => `${entry.comment}(${size(entry)})`).join('、')}`)
const overFile = entries.filter(entry => Buffer.byteLength(entry.content ?? '', 'utf8') > MAXIMUM_MARKDOWN_BYTES)
verdict(overFile.length === 0, `单个 Markdown 文件（上限 ${MAXIMUM_MARKDOWN_BYTES / KIB} KiB）`,
  overFile.length === 0 ? '' : `${overFile.length} 条装不进一个文件，每段还需各自 ≤${MAXIMUM_DELIVERY} 字符：${overFile.slice(0, 3).map(entry => entry.comment).join('、')}`)
const overKeywords = entries.filter(entry => (entry.keys ?? []).length > MAXIMUM_KEYWORDS)
const longKeywords = entries.filter(entry => (entry.keys ?? []).some(key => key.length > MAXIMUM_KEYWORD_LENGTH))
verdict(overKeywords.length === 0 && longKeywords.length === 0, '关键词形状（每条 ≤256 个、每个 ≤512 字符）',
  overKeywords.length + longKeywords.length === 0 ? '' : `${overKeywords.length} 条关键词过多、${longKeywords.length} 条含超长关键词`)

// 常驻条目每回合都要投递；超出预算的部分会被静默跳过。knowledge 的 when 可以把条目改成按状态激活。
verdict(constantCharacters <= MAXIMUM_DELIVERY, '常驻合计 vs 单次投递预算',
  `${constantCharacters} 字符，占满 ${((constantCharacters / MAXIMUM_DELIVERY) * 100).toFixed(1)}% 预算${constantCharacters > MAXIMUM_DELIVERY ? '，超出部分会被跳过；可用 when 条件把阶段性条目移出常驻' : ''}`)

const profiles = CONTEXT_PROFILES.map(profile => `${profile.profileId}=${profile.recallResults}`).join(' / ')
line('记忆召回上限', profiles)
line('知识召回策略', '关键词子串匹配，任意条命中即投递；可选 when（JSON Schema）按接收者已知状态过滤')

// ── 2. 状态 ─────────────────────────────────────────────────
// 上限见 desktop/host/pack-status.ts：状态 ≤64、操作 ≤32、单值 16 KiB、总量 512 KiB、脚本 64 KiB。
console.log('\n【变量 → scripts/status.js】')
const MAXIMUM_STATUSES = 64, MAXIMUM_OPERATIONS = 32
const VALUE_LIMIT = 16 * KIB, TOTAL_LIMIT = 512 * KIB, SCRIPT_LIMIT = 64 * KIB
line('宿主容量', `状态 ${MAXIMUM_STATUSES} / 操作 ${MAXIMUM_OPERATIONS} / 单值 ${VALUE_LIMIT / KIB} KiB / 总量 ${TOTAL_LIMIT / KIB} KiB`)
line('值类型', 'number / string / boolean / object / array / null，可带 JSON Schema')

const schemaScript = scripts.find(script => /zod|schema|变量结构/i.test(script.name ?? ''))
const roots = schemaScript?.content === undefined ? undefined : topLevelKeys(schemaScript.content)
if (schemaScript !== undefined) line('变量脚本', `${schemaScript.name ?? '(匿名)'} ${((schemaScript.content ?? '').length / KIB).toFixed(1)} KB`)
if (roots === undefined) {
  line('根变量', schemaScript === undefined ? '（卡里没有可解析的变量脚本）' : '（未能自动解析 zod 根结构，需人工映射）')
} else {
  const fits = roots.length <= MAXIMUM_STATUSES
  verdict(fits, `根变量 → 状态（${roots.length} 个，上限 ${MAXIMUM_STATUSES}）`, fits ? roots.join('、') : roots.slice(0, 12).join('、') + ' …')
  line('提醒', '嵌套对象可整体作为一个 object 状态；单值超过 16 KiB 需拆分或改成字符串')
}
line('模型写入', '不支持：叙事里的 <UpdateVariable> 不被解析，每个可写字段须改写成 resolve 分支或活动附带变化')
if (schemaScript !== undefined) {
  const scriptKiB = ((schemaScript.content ?? '').length / KIB).toFixed(1)
  verdict((schemaScript.content ?? '').length <= SCRIPT_LIMIT, `改写为 status.js（上限 ${SCRIPT_LIMIT / KIB} KiB）`,
    `原变量脚本 ${scriptKiB} KiB；改成状态声明后通常更小，但需要人工重排`)
}

// ── 3. 正则脚本 → 文本规则 ───────────────────────────────────
console.log('\n【正则脚本 → 预设文本规则】')
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

// ── 4. 开局与角色 ────────────────────────────────────────────
console.log('\n【开局 / 角色】')
line('first_mes', `${(data.first_mes ?? '').length} 字符`)
line('alternate_greetings', `${(data.alternate_greetings ?? []).length} 条`)
line('带 [Pro]/[Lite] 角色词条', `${entries.filter(entry => /\[(Pro|Lite)\]/.test(entry.comment ?? '')).length} 条`)
line('开局机制', '宿主无多开局概念：player-slots 恰好 1 个，起点由创世决定；既有做法是活动 operations 菜单')

console.log('')
