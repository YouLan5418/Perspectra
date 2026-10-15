/**
 * SillyTavern preset -> Perspectra RolePreset converter.
 *
 * A foreign preset is not a runtime format: this reads it once, offline, and writes native output that
 * the existing strict validator accepts. Nothing here runs while a world is open, and no compatibility
 * branch is added to the runtime: an unfamiliar field is reported and dropped rather than tolerated.
 *
 * Two mappings are lossy by design and are always reported:
 *  - `injection_depth` / `minDepth` / `maxDepth` have no Perspectra equivalent: the Host exposes one
 *    Context slot, and history is an Event prefix rather than numbered floors.
 *  - Macros the Host does not implement are removed, because an unknown `{{...}}` fails validation.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { rolePreset, type PromptNode, type RolePreset, type TextRule } from '../src/preset.ts'
import { validatePresetMacros } from '../src/preset-macros.ts'

interface ForeignPrompt {
  readonly identifier?: unknown
  readonly name?: unknown
  readonly content?: unknown
  readonly role?: unknown
  readonly marker?: unknown
  readonly enabled?: unknown
  readonly system_prompt?: unknown
}
interface ForeignRegex {
  readonly scriptName?: unknown
  readonly findRegex?: unknown
  readonly replaceString?: unknown
  readonly disabled?: unknown
  readonly markdownOnly?: unknown
  readonly promptOnly?: unknown
  readonly placement?: unknown
  readonly minDepth?: unknown
  readonly maxDepth?: unknown
  readonly trimStrings?: unknown
  readonly substituteRegex?: unknown
}
interface ForeignPreset {
  readonly prompts?: unknown
  readonly prompt_order?: unknown
  readonly temperature?: unknown
  readonly top_p?: unknown
  readonly frequency_penalty?: unknown
  readonly presence_penalty?: unknown
  readonly openai_max_tokens?: unknown
  readonly stop_strings?: unknown
  readonly extensions?: unknown
}

const MAXIMUM_NODE_CHARACTERS = 16_000
const MAXIMUM_TOTAL_CHARACTERS = 32_000
const MAXIMUM_OUTPUT_TOKENS = 32_768

/** Macros the Host implements with the same spelling and arity as the foreign preset. */
const SHARED_MACROS = new Set(['char', 'user', 'scene', 'date', 'time', 'trim'])
/** Macros rewritten to the Host spelling; the foreign form uses one colon or commas. */
function rewriteMacro(body: string): string | undefined {
  if (body.startsWith('roll:')) return `roll::${body.slice('roll:'.length)}`
  if (body.startsWith('random:')) {
    const choices = body.slice('random:'.length).split(',').map(choice => choice.trim()).filter(Boolean)
    return choices.length === 0 ? undefined : `random::${choices.join('::')}`
  }
  return undefined
}

interface MacroOutcome { readonly text: string; readonly kept: string[]; readonly rewritten: string[]; readonly dropped: string[] }

function sanitizeMacros(content: string): MacroOutcome {
  const kept: string[] = [], rewritten: string[] = [], dropped: string[] = []
  const text = content.replace(/\{\{([\s\S]*?)\}\}/gu, (match, raw: string) => {
    const body = raw.trim()
    if (body.startsWith('//')) { kept.push('{{//注释}}'); return match }
    if (SHARED_MACROS.has(body)) { kept.push(`{{${body}}}`); return match }
    if (body.startsWith('getvar::') || body.startsWith('setvar::')) { kept.push(`{{${body.split('::')[0]}::…}}`); return match }
    const converted = rewriteMacro(body)
    if (converted !== undefined) { rewritten.push(`{{${body}}} → {{${converted}}}`); return `{{${converted}}}` }
    dropped.push(`{{${body}}}`)
    return ''
  })
  return { text, kept: [...new Set(kept)], rewritten: [...new Set(rewritten)], dropped: [...new Set(dropped)] }
}

const asArray = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []
const asText = (value: unknown): string => typeof value === 'string' ? value : ''
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** `/pattern/flags` as SillyTavern stores it. The first group is greedy so an escaped `/` stays inside. */
function parseFindRegex(value: string): { pattern: string; flags: string } {
  const match = /^\/([\s\S]*)\/([a-z]*)$/u.exec(value)
  return match === null ? { pattern: value, flags: '' } : { pattern: match[1]!, flags: match[2]! }
}

interface Report {
  readonly nodes: { name: string; source: string; enabled: boolean; position: PromptNode['position'] }[]
  readonly skippedMarkers: string[]
  readonly skippedBlank: string[]
  readonly notInOrder: string[]
  readonly rules: { name: string; stage: TextRule['stage']; source: string }[]
  readonly rulesSkipped: { name: string; reason: string }[]
  readonly macrosKept: string[]
  readonly macrosRewritten: string[]
  readonly macrosDropped: string[]
  readonly dropped: string[]
  readonly notes: string[]
}

function convert(source: ForeignPreset, options: { name: string; orderIndex: number | undefined; keepPenalties: boolean; keepStop: boolean }): { preset: RolePreset; report: Report } {
  const report: Report = { nodes: [], skippedMarkers: [], skippedBlank: [], notInOrder: [], rules: [], rulesSkipped: [],
    macrosKept: [], macrosRewritten: [], macrosDropped: [], dropped: [], notes: [] }

  // One prompt_order entry is the active arrangement. Shared presets ship several; the one that enables
  // the most entries is the arrangement the author actually used, so it is the default.
  const orders = asArray(source.prompt_order).map(asRecord)
  const enabledCounts = orders.map(order => asArray(order.order).filter(entry => asRecord(entry).enabled === true).length)
  const chosen = options.orderIndex ?? (enabledCounts.length === 0 ? 0 : enabledCounts.indexOf(Math.max(...enabledCounts)))
  const order = orders[chosen]
  if (orders.length > 1) {
    report.notes.push(options.orderIndex === undefined
      ? `预设里有 ${orders.length} 组 prompt_order，自动采用启用条目最多的一组（第 ${chosen + 1} 组，启用 ${enabledCounts[chosen] ?? 0} 条）；可用 --order 指定`
      : `预设里有 ${orders.length} 组 prompt_order，按参数使用第 ${chosen + 1} 组；其余顺序未转换`)
  }
  const orderEntries = asArray(order?.order).map(asRecord)
  const orderIndex = new Map<string, boolean>()
  orderEntries.forEach(entry => { if (typeof entry.identifier === 'string') orderIndex.set(entry.identifier, entry.enabled === true) })
  const chatHistoryAt = orderEntries.findIndex(entry => entry.identifier === 'chatHistory')

  const nodes: PromptNode[] = []
  for (const [index, value] of asArray(source.prompts).entries()) {
    const prompt = value as ForeignPrompt
    const identifier = asText(prompt.identifier) || `prompt-${index}`
    const name = asText(prompt.name) || identifier
    if (prompt.marker === true) { report.skippedMarkers.push(name); continue }
    const content = asText(prompt.content)
    if (content.trim().length === 0) { report.skippedBlank.push(name); continue }
    // A prompt the active order omits is not injected at all in the foreign runtime.
    const ordered = orderIndex.has(identifier)
    const enabled = orders.length === 0 ? prompt.enabled !== false : (orderIndex.get(identifier) ?? false)
    if (orders.length > 0 && !ordered) report.notInOrder.push(name)

    const positionAt = orderEntries.findIndex(entry => entry.identifier === identifier)
    const position: PromptNode['position'] = chatHistoryAt < 0 ? 'beforeContext'
      : positionAt < 0 ? 'beforeContext' : positionAt > chatHistoryAt ? 'afterContext' : 'beforeContext'
    const macros = sanitizeMacros(content)
    report.macrosKept.push(...macros.kept)
    report.macrosRewritten.push(...macros.rewritten)
    report.macrosDropped.push(...macros.dropped)
    const trimmed = macros.text.length > MAXIMUM_NODE_CHARACTERS ? macros.text.slice(0, MAXIMUM_NODE_CHARACTERS) : macros.text
    if (trimmed !== macros.text) report.dropped.push(`节点「${name}」超出 ${MAXIMUM_NODE_CHARACTERS} 字符，已截断`)
    const role = prompt.role === 'user' || prompt.role === 'assistant' ? prompt.role : 'system'
    nodes.push({ id: identifier.slice(0, 100), name: name.slice(0, 80), enabled, role, position, content: trimmed })
    report.nodes.push({ name, source: identifier, enabled, position })
  }

  // The prompts array is a catalogue; only prompt_order defines execution order.
  const rank = (id: string) => orderEntries.findIndex(entry => entry.identifier === id)
  if (orders.length > 0) nodes.sort((left, right) =>
    (rank(left.id) < 0 ? Infinity : rank(left.id)) - (rank(right.id) < 0 ? Infinity : rank(right.id)))

  const textRules: TextRule[] = []
  const regexes = asArray(asRecord(source.extensions).regex_scripts).map(asRecord) as ForeignRegex[]
  if (regexes.length === 0) report.notes.push('这份预设没有 regex_scripts，未转换任何文本规则')
  for (const [index, rule] of regexes.entries()) {
    const name = asText(rule.scriptName) || `regex-${index}`
    const raw = asText(rule.findRegex)
    if (raw.length === 0) { report.rulesSkipped.push({ name, reason: 'findRegex 为空' }); continue }
    const { pattern, flags } = parseFindRegex(raw)
    const safeFlags = [...new Set(flags.replace(/[^gimsu]/gu, ''))].join('')
    if (flags !== safeFlags) report.notes.push(`规则「${name}」的标志 ${JSON.stringify(flags)} 含不支持项，已收窄为 ${JSON.stringify(safeFlags)}`)
    const replacement = asText(rule.replaceString)
    if (pattern.length > 1000) { report.rulesSkipped.push({ name, reason: '正则超过 1000 字符' }); continue }
    if (replacement.length > 4000) { report.rulesSkipped.push({ name, reason: '替换文本超过 4000 字符' }); continue }
    try { new RegExp(pattern, safeFlags) } catch { report.rulesSkipped.push({ name, reason: '正则无法编译' }); continue }
    if (rule.minDepth !== null && rule.minDepth !== undefined) report.notes.push(`规则「${name}」的 minDepth=${String(rule.minDepth)} 没有对应概念，已忽略`)
    if (rule.maxDepth !== null && rule.maxDepth !== undefined) report.notes.push(`规则「${name}」的 maxDepth=${String(rule.maxDepth)} 没有对应概念，已忽略`)
    if (asArray(rule.trimStrings).length > 0) report.notes.push(`规则「${name}」的 trimStrings 未转换`)
    if (rule.substituteRegex !== undefined && rule.substituteRegex !== 0) report.notes.push(`规则「${name}」的 substituteRegex 未转换`)

    const placement = asArray(rule.placement).map(Number)
    const enabled = rule.disabled !== true
    const stages: TextRule['stage'][] = []
    // promptOnly changes what the model reads; markdownOnly changes what the player reads. They are
    // independent in the foreign runtime, so one source rule can become two Host rules.
    if (rule.promptOnly === true) {
      if (placement.includes(1)) stages.push('input')
      if (placement.includes(2)) stages.push('history')
    }
    if (rule.markdownOnly === true) stages.push('display')
    if (stages.length === 0) { report.rulesSkipped.push({ name, reason: '既不改提示也不改展示，在 Perspectra 里没有作用' }); continue }
    for (const stage of new Set(stages)) {
      // The index keeps identities unique: a foreign script name may be non-Latin entirely, and one
      // source rule can legitimately become both a history rule and a display rule.
      const id = `${index}-${ruleSlug(asText(rule.scriptName) || 'rule')}-${stage}`
      textRules.push({ id: id.slice(0, 100), name: `${name} · ${stage}`.slice(0, 80), enabled, stage, target: 'both',
        pattern, flags: safeFlags, replacement })
      report.rules.push({ name, stage, source: `${stage}` })
    }
  }

  // Generation parameters. Penalties and stop strings are dropped unless asked for: a gateway that does
  // not support them rejects the whole request, and the Host can only report the HTTP status.
  const generation: Partial<RolePreset> = {}
  const temperature = source.temperature
  if (typeof temperature === 'number' && temperature >= 0 && temperature <= 2) generation.temperature = temperature
  else if (temperature !== undefined) report.dropped.push(`temperature=${String(temperature)} 超出 0–2`)
  const topP = source.top_p
  if (typeof topP === 'number' && topP >= 0 && topP <= 1) generation.topP = topP
  else if (topP !== undefined) report.dropped.push(`top_p=${String(topP)} 超出 0–1`)
  const maximum = source.openai_max_tokens
  if (typeof maximum === 'number' && maximum >= 1) {
    generation.maxOutputTokens = Math.min(Math.trunc(maximum), MAXIMUM_OUTPUT_TOKENS)
    if (generation.maxOutputTokens !== maximum) report.dropped.push(`openai_max_tokens=${maximum} 超过上限，收窄为 ${MAXIMUM_OUTPUT_TOKENS}`)
  }
  for (const key of ['frequency_penalty', 'presence_penalty'] as const) {
    const value = source[key]
    if (typeof value !== 'number' || value === 0) continue
    if (options.keepPenalties) generation[key === 'frequency_penalty' ? 'frequencyPenalty' : 'presencePenalty'] = value
    else report.dropped.push(`${key}=${value} 默认不转换（部分模型不支持该参数，网关会直接拒绝整个请求）；需要时用 --keep-penalties`)
  }
  const stop = asArray(source.stop_strings).filter((value): value is string => typeof value === 'string')
  if (stop.length > 0) {
    if (options.keepStop) generation.stop = stop.slice(0, 4)
    else report.dropped.push(`stop_strings 共 ${stop.length} 条默认不转换（停止词会截断受约束 JSON 输出）；需要时用 --keep-stop`)
  }

  // The Host accepts at most 64 nodes. Disabled ones are dropped first, from the end, so that the
  // relative order of everything that survives is the order the foreign runtime used.
  const MAXIMUM_NODES = 64
  if (nodes.length > MAXIMUM_NODES) {
    for (let index = nodes.length - 1; index >= 0 && nodes.length > MAXIMUM_NODES; index -= 1) {
      if (nodes[index]!.enabled) continue
      report.dropped.push(`节点「${nodes[index]!.name}」超出 ${MAXIMUM_NODES} 个上限（未启用），已丢弃`)
      nodes.splice(index, 1)
    }
    if (nodes.length > MAXIMUM_NODES) {
      for (const node of nodes.slice(MAXIMUM_NODES)) report.dropped.push(`节点「${node.name}」超出 ${MAXIMUM_NODES} 个上限（已启用），已丢弃`)
      nodes.length = MAXIMUM_NODES
    }
    report.notes.push('源预设节点多于 Host 上限，请核对上面被丢弃的节点；被丢弃的启用节点需要手工合并')
  }

  const total = nodes.reduce((sum, node) => sum + node.content.length, 0)
  if (total > MAXIMUM_TOTAL_CHARACTERS) report.dropped.push(`启用节点内容合计 ${total} 字符，超过 ${MAXIMUM_TOTAL_CHARACTERS}；请禁用或删减节点`)

  return { preset: { nodes, textRules, ...generation }, report }
}

function ruleSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
  return slug.length > 0 ? slug : 'rule'
}

interface Options { input: string; out: string; name: string; orderIndex: number | undefined; keepPenalties: boolean; keepStop: boolean }

function parseArguments(argv: readonly string[]): Options {
  const positional: string[] = []
  let out: string | undefined, name: string | undefined, orderIndex: number | undefined, keepPenalties = false, keepStop = false
  for (const [index, argument] of argv.entries()) {
    if (argument === '--out') out = argv[index + 1]
    else if (argument === '--name') name = argv[index + 1]
    else if (argument === '--order') orderIndex = Number(argv[index + 1] ?? 0)
    else if (argument === '--keep-penalties') keepPenalties = true
    else if (argument === '--keep-stop') keepStop = true
    else if (!argument.startsWith('--') && argv[index - 1]?.startsWith('--') !== true) positional.push(argument)
  }
  const input = positional[0]
  if (input === undefined) {
    throw new TypeError('用法：tavern-import <酒馆预设.json> [--out <输出.json>] [--name <预设名>] [--order <n>] [--keep-penalties] [--keep-stop]')
  }
  const stem = basename(input, extname(input))
  return { input, out: out ?? `${stem}.perspectra.json`, name: name ?? stem,
    orderIndex: orderIndex !== undefined && Number.isSafeInteger(orderIndex) ? orderIndex : undefined, keepPenalties, keepStop }
}

const options = parseArguments(process.argv.slice(2))
const source = JSON.parse(readFileSync(resolve(options.input), 'utf8')) as ForeignPreset
if (!Array.isArray(source.prompts)) throw new TypeError('这不是酒馆预设：缺少 prompts 数组')

const { preset, report } = convert(source, options)

// The converter is only useful if its output passes the same validator the runtime uses.
const validated = rolePreset(preset)
for (const node of validated.nodes ?? []) {
  if (!node.enabled) continue
  try { validatePresetMacros(node.content) } catch (error) {
    throw new TypeError(`节点「${node.name}」转换后宏仍不合法：${error instanceof Error ? error.message : String(error)}`)
  }
}
const library = { format: 'perspectra-model-preset', schemaVersion: 1, presets: [{ name: options.name, preset: validated }] }
writeFileSync(resolve(options.out), JSON.stringify(library, null, 2) + '\n')

const line = (label: string, values: readonly string[]): void => {
  if (values.length > 0) console.log(`  ${label}：${values.join('、')}`)
}
console.log(`\n源文件：${options.input}`)
console.log(`输出：${options.out}（preset 名「${options.name}」）`)
console.log(`\n节点 ${validated.nodes?.length ?? 0} 个（启用 ${(validated.nodes ?? []).filter(node => node.enabled).length} 个）`)
for (const node of report.nodes) console.log(`  ${node.enabled ? '✓' : '·'} ${node.name}  [${node.position}${node.enabled ? '' : ' · 未启用'}]`)
line('跳过·内置插槽', report.skippedMarkers)
line('跳过·空内容', report.skippedBlank)
line('不在启用顺序中', report.notInOrder)
console.log(`\n文本规则 ${validated.textRules?.length ?? 0} 条`)
for (const rule of report.rules) console.log(`  ✓ ${rule.name}  [${rule.stage}]`)
for (const rule of report.rulesSkipped) console.log(`  · ${rule.name}（跳过：${rule.reason}）`)
console.log('\n宏处理')
line('保留', report.macrosKept)
line('改写', report.macrosRewritten)
line('移除（Perspectra 不支持）', report.macrosDropped)
if (report.dropped.length > 0) { console.log('\n未转换'); line('项', report.dropped) }
if (report.notes.length > 0) { console.log('\n说明'); line('项', report.notes) }
console.log('\n已通过 rolePreset 校验。')
