import { Script } from 'node:vm'
import {
  parseVariable,
  variableKey,
  acceptsVariableValue,
  rulingTargets,
  type EditorVariable,
  type Scalar,
} from '@perspectra/world-pack/editor-fields'
import { SCRIPT_SOURCE_LIMIT } from '@perspectra/sdk/contracts'

export type RuleTarget = { kind: 'local' | 'world'; ref: string }
export type ChoiceRuling = { target: RuleTarget } & (
  | { kind: 'cost'; amount: number; rejectReason: string }
  | { kind: 'script'; script: string; parameters: Record<string, Scalar> }
)
export interface RuleDeclaration {
  key: string
  title: string
  type: EditorVariable['type']
  parameters: EditorVariable[]
}
export function readRuling(raw: unknown): ChoiceRuling {
  if (!raw || typeof raw !== 'object') throw new TypeError('请选择裁定方式')
  const r = raw as Record<string, unknown>
  const t = r.target as Partial<RuleTarget> | null
  if (!t || (t.kind !== 'local' && t.kind !== 'world')) throw new TypeError('请选择裁定变量')
  const target = { kind: t.kind, ref: variableKey(t.ref) }
  if (
    r.kind === 'cost' &&
    typeof r.amount === 'number' &&
    Number.isSafeInteger(r.amount) &&
    r.amount > 0 &&
    typeof r.rejectReason === 'string' &&
    r.rejectReason.trim() &&
    r.rejectReason.length <= 2000
  )
    return { kind: 'cost', target, amount: r.amount, rejectReason: r.rejectReason }
  if (r.kind === 'script' && r.parameters && typeof r.parameters === 'object' && !Array.isArray(r.parameters)) {
    const params = Object.fromEntries(
      Object.entries(r.parameters).map(([k, v]) => {
        if (!['number', 'boolean', 'string'].includes(typeof v)) throw new TypeError('裁定参数需要标量')
        return [variableKey(k), v as Scalar]
      }),
    )
    return { kind: 'script', target, script: variableKey(r.script), parameters: params }
  }
  throw new TypeError('请填写有效裁定、正整数消耗和不足时的提示')
}
const marker = '// @perspectra-rule '
export function parseRuleSource(key: string, source: string) {
  const normalized = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
  const newline = normalized.indexOf('\n')
  if (Buffer.byteLength(source) > SCRIPT_SOURCE_LIMIT || newline < 0 || !normalized.startsWith(marker))
    throw new TypeError(key + '：首行需要 // @perspectra-rule 和 JSON 声明')
  const meta = JSON.parse(normalized.slice(marker.length, newline))
  if (
    !meta ||
    typeof meta.title !== 'string' ||
    !meta.title.trim() ||
    meta.title.length > 80 ||
    !['number', 'boolean', 'string'].includes(meta.type) ||
    !Array.isArray(meta.parameters)
  )
    throw new TypeError(key + '：请声明名称、变量类型和参数列表')
  const parameters: EditorVariable[] = meta.parameters.map(parseVariable)
  if (new Set(parameters.map(v => v.key)).size !== parameters.length) throw new TypeError(key + '：参数键重复')
  const declaration: RuleDeclaration = { key, title: meta.title, type: meta.type, parameters }
  const code = normalized.slice(newline + 1).trim()
  if (!/^export\s+default\s+function(?:\s+[a-zA-Z_$][\w$]*)?\s*\(/.test(code))
    throw new TypeError(key + '：需要 export default function(value, parameters) 声明')
  const expression = code.replace(/^export\s+default\s+/, '').replace(/;\s*$/, '')
  new Script('(' + expression + '\n)', { filename: 'scripts/adjudications/' + key + '.js' })
  return { declaration, expression }
}
export function validateRuling(
  r: ChoiceRuling,
  targets: ReturnType<typeof rulingTargets>,
  declarations: RuleDeclaration[],
) {
  const def = targets.find(v => v.kind === r.target.kind && v.key === r.target.ref)
  const script = r.kind === 'script' ? declarations.find(d => d.key === r.script) : undefined
  if (r.kind === 'script' && !script) throw new TypeError('裁定脚本不存在：' + r.script)
  if (!def || def.type !== (script?.type ?? 'number'))
    throw new TypeError('裁定变量不可读写或类型不符：' + r.target.ref)
  if (r.kind === 'script' && script) {
    if (
      Object.keys(r.parameters).length !== script.parameters.length ||
      script.parameters.some(p => !Object.hasOwn(r.parameters, p.key) || !acceptsVariableValue(p, r.parameters[p.key]))
    )
      throw new TypeError('请根据最新声明填写裁定参数：' + r.script)
  }
}
