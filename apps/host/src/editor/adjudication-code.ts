import { parseRuleSource } from './adjudication.ts'
export const sourcesMarker = '// Perspectra adjudication sources '
// Keep the author inputs next to the executable form so a reopened export can distinguish a generated file from a hand edit.
export function rulingCode(sources: Record<string, string>) {
  const entries = Object.entries(sources).map(
    ([key, source]) => JSON.stringify(key) + ': (' + parseRuleSource(key, source).expression + '\n)',
  )
  return (
    sourcesMarker +
    JSON.stringify(sources) +
    '\nconst customRules = {' +
    entries.join(',\n') +
    '}\n' +
    `function settleRuling(rule, game, actor, truth, changes) {
  const target = rule.target
  const local = target.kind === 'local' ? graph.variables.find(v => v.key === target.ref) : null
  const values = local ? (local.scope === 'shared' ? game.public : game.private[actor]).variables : truth?.public
  if (!values || !Object.hasOwn(values, target.ref)) return {rejectReason:'当前无法读取裁定变量。'}
  const before = values[target.ref]
  const outcome = rule.kind === 'cost'
    ? (before < rule.amount ? {rejectReason:rule.rejectReason} : {value:before-rule.amount})
    : customRules[rule.script](before, rule.parameters)
  if (!outcome || typeof outcome !== 'object' || Object.keys(outcome).length !== 1)
    throw new TypeError('裁定须返回一个 value 或 rejectReason')
  if (Object.hasOwn(outcome,'rejectReason')) {
    if (typeof outcome.rejectReason !== 'string' || !outcome.rejectReason.trim() || outcome.rejectReason.length > 2000)
      throw new TypeError('裁定拒绝原因无效')
    return {rejectReason:outcome.rejectReason}
  }
  const value = outcome.value
  if (!Object.hasOwn(outcome,'value') || typeof value !== typeof before ||
    (typeof value === 'number' && (!Number.isSafeInteger(value) || Object.is(value,-0))) ||
    (typeof value === 'string' && (value.length>2000 || (local?.options && !local.options.includes(value)))))
    throw new TypeError('裁定返回值与变量声明不符')
  if(local) values[target.ref]=value
  else changes.push({holderId:null,key:target.ref,value})
}
`
  )
}
