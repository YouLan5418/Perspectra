import {
  conditionLeaves,
  parseVariable,
  variableKey,
  type ChoiceCondition,
  type ConditionLeaf,
  type LocalVariable,
  type VariableUse,
} from '@perspectra/world-pack/editor-fields'
import { readRuling, type ChoiceRuling } from './adjudication.ts'
import { rulingCode, sourcesMarker } from './adjudication-code.ts'
export type { ChoiceCondition } from '@perspectra/world-pack/editor-fields'
export function conditionReferences(condition: ChoiceCondition) {
  return conditionLeaves(condition).map((use, i) => ({
    use,
    field: 'conditions' in condition ? 'condition/' + i : 'condition',
    label: 'conditions' in condition ? '出现条件 ' + (i + 1) : '出现条件',
  }))
}
export interface EditorChoice {
  id: string
  label: string
  condition: ChoiceCondition
  ruling?: ChoiceRuling
  effect?: VariableUse
  result: string
  speech: string
  next: 'end' | 'stay'
}
export interface LayoutNode {
  id: string
  title?: string
  parent?: string
  x?: number
  y?: number
}
export interface EditorGraph {
  layout?: LayoutNode[]
  key: string
  title: string
  opening: string
  variables?: LocalVariable[]
  choices: EditorChoice[]
}

function row(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))
  )
    throw new TypeError('活动字段格式无效')
  return value as Record<string, unknown>
}
function text(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new TypeError('请检查字段：' + field)
  return value
}
export function editorKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9-]{0,40}$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)
  )
    throw new TypeError('标识须为可移植的小写字母、数字或连字符')
  return value
}
function variableUse(raw: Record<string, unknown>): VariableUse {
  if ((raw.kind !== 'local' && raw.kind !== 'world') || !['string', 'number', 'boolean'].includes(typeof raw.value))
    throw new TypeError('变量引用需要范围、键和值')
  return { kind: raw.kind, ref: variableKey(raw.ref), value: raw.value as VariableUse['value'] }
}
function readLeaf(value: unknown): ConditionLeaf {
  const p = row(value, ['kind', 'ref', 'value', 'negate'])
  if ((p.kind === 'always' || p.kind === 'alone') && Object.keys(p).length === 1) return { kind: p.kind }
  if (Object.hasOwn(p, 'negate') && (p.negate !== true || (p.kind !== 'present' && p.kind !== 'location')))
    throw new TypeError('只有地点和在场条件可取反')
  if (p.kind === 'world' || p.kind === 'local') return variableUse(p)
  if ((p.kind === 'present' || p.kind === 'location') && !Object.hasOwn(p, 'value'))
    return { kind: p.kind, ref: text(p.ref, '引用', 200), ...(p.negate ? { negate: true } : {}) }
  if ((p.kind === 'held' || p.kind === 'party') && !Object.hasOwn(p, 'value'))
    return { kind: p.kind, ref: text(p.ref, '引用', 200) }
  throw new TypeError('选项条件无效')
}
function readCondition(value: unknown): ChoiceCondition {
  if (!value || typeof value !== 'object' || !('kind' in value) || (value.kind !== 'all' && value.kind !== 'any'))
    return readLeaf(value)
  const group = row(value, ['kind', 'conditions'])
  if (!Array.isArray(group.conditions) || group.conditions.length < 2) throw new TypeError('组合条件至少需要两项')
  return {
    kind: value.kind,
    conditions: group.conditions.map(raw => {
      const c = readLeaf(raw)
      if (c.kind === 'always') throw new TypeError('组合中的每一项都需要具体条件')
      return c
    }),
  }
}
export function parseGraph(value: unknown): EditorGraph {
  const graph = row(value, ['key', 'title', 'opening', 'choices', 'variables', 'layout'])
  if (!Array.isArray(graph.choices) || graph.choices.length > 16) throw new TypeError('每个活动最多 16 个选项')
  const ids = new Set(['start', 'retry', 'resume', 'suspend', 'abandon', 'escape'])
  const localKeys = new Set<string>()
  if (graph.variables !== undefined && (!Array.isArray(graph.variables) || graph.variables.length > 64))
    throw new TypeError('活动变量列表无效')
  const variables = (graph.variables as unknown[] | undefined)?.map(raw => {
    const v = row(raw, ['key', 'label', 'type', 'scope', 'initial', 'options'])
    const def = parseVariable(v)
    if (localKeys.has(def.key) || (v.scope !== 'shared' && v.scope !== 'private' && v.scope !== 'internal'))
      throw new TypeError('活动变量范围无效或键重复：' + def.key)
    localKeys.add(def.key)
    return { ...def, scope: v.scope } as LocalVariable
  })
  const choices = graph.choices.map((raw): EditorChoice => {
    const c = row(raw, ['id', 'label', 'condition', 'result', 'speech', 'next', 'effect', 'ruling'])
    const id = editorKey(c.id)
    if (ids.has(id)) throw new TypeError('选项标识重复或已保留：' + id)
    ids.add(id)
    const condition = readCondition(c.condition)
    if (c.next !== 'end' && c.next !== 'stay') throw new TypeError('选项去向无效：' + id)
    return {
      id,
      label: text(c.label, '选项文案', 80),
      condition,
      ...(c.ruling == null ? {} : { ruling: readRuling(c.ruling) }),
      ...(c.effect === undefined ? {} : { effect: variableUse(row(c.effect, ['kind', 'ref', 'value'])) }),
      result: text(c.result, '结果', 2000, false),
      speech: text(c.speech, '玩家发言', 2000, false),
      next: c.next,
    }
  })
  const layout = parseLayout(
    graph.layout,
    choices.map(c => c.id),
  )
  return {
    key: editorKey(graph.key),
    title: text(graph.title, '活动名称', 80),
    opening: text(graph.opening, '开场', 500, false),
    ...(variables?.length ? { variables } : {}),
    choices,
    ...(layout.length ? { layout } : {}),
  }
}

function parseLayout(raw: unknown, choices: string[]): LayoutNode[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 128) throw new TypeError('画布节点数量无效')
  const nodes = new Map<string, LayoutNode>()
  const fixed = new Set(['start', ...choices])
  for (const input of raw) {
    const v = row(input, ['id', 'title', 'parent', 'x', 'y'])
    const id = editorKey(v.id)
    const node: LayoutNode = { id }
    if (nodes.has(id)) throw new TypeError('画布节点重复：' + id)
    if (v.title !== undefined) node.title = text(v.title, '子流程名称', 80)
    if (fixed.has(id) === !!node.title) throw new TypeError('画布节点与活动不匹配：' + id)
    if (v.parent !== undefined) node.parent = editorKey(v.parent)
    if (id === 'start' && node.parent) throw new TypeError('开场必须位于主流程')
    if (v.x !== undefined || v.y !== undefined) {
      for (const k of ['x', 'y'] as const) {
        const n = v[k]
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > 12000) throw new TypeError('画布坐标无效')
        node[k] = n
      }
    }
    nodes.set(id, node)
  }
  for (const node of nodes.values()) {
    const seen = new Set([node.id])
    let parent = node.parent
    while (parent) {
      if (seen.has(parent) || !nodes.get(parent)?.title) throw new TypeError('子流程层级无效：' + node.id)
      seen.add(parent)
      parent = nodes.get(parent)?.parent
    }
  }
  return [...nodes.values()]
}

const header = '// Perspectra authored activity\nconst graph = '
export function activityScript(graph: EditorGraph, sources: Record<string, string> = {}): string {
  const hasRulings = graph.choices.some(c => c.ruling)
  const predicates = graph.choices.flatMap(c => conditionLeaves(c.condition))
  const party = predicates.some(p => p.kind === 'party')
  const worldConditions = party || predicates.some(p => p.kind === 'world')
  const places = predicates.some(p => p.kind === 'location')
  const presence = predicates.some(p => p.kind === 'alone' || (p.kind === 'present' && p.negate))
  // Emit only the new checks a graph uses to preserve the source signatures of existing exports.
  const sceneChecks: string[] = []
  if (places)
    sceneChecks.push(
      "if (condition.kind === 'location') return typeof scene.locationId === 'string' && (scene.locationId === condition.ref) !== !!condition.negate",
    )
  if (presence)
    sceneChecks.push(
      "if (condition.kind === 'alone') return scene.characterIds.length === 1 && scene.characterIds[0] === scene.actorId",
      "if (condition.kind === 'present' && condition.negate) return scene.characterIds.includes(scene.actorId) && !scene.characterIds.includes(condition.ref)",
    )
  if (party)
    sceneChecks.push(
      "if (condition.kind === 'party') return scene.characterIds.includes(condition.ref) && Array.isArray(known['rpg-party']) && known['rpg-party'].includes(condition.ref)",
    )
  const sceneCode = sceneChecks.map(check => '  ' + check + '\n').join('')
  const usesVariables = hasRulings || !!graph.variables?.length || worldConditions || graph.choices.some(c => c.effect)
  const readsStatus = worldConditions || graph.choices.some(c => c.ruling?.target.kind === 'world')
  const args = usesVariables ? ', game, known' : ''
  // Keep the original source signature for existing single-condition activities.
  const predicateBody = graph.choices.some(c => 'conditions' in c.condition)
    ? `  const c = choice.condition
  const test = p => matches(p, scene${args})
  return c.kind === 'all' ? c.conditions.every(test) : c.kind === 'any' ? c.conditions.some(test) : test(c)
}
function matches(condition, scene${args}) {`
    : '  const condition = choice.condition'
  let applyRuling = '',
    appendEffect = ''
  let statusResult = usesVariables
    ? " ...(effect?.kind === 'world' ? {status:{changes:[{holderId:null,key:effect.ref,value:effect.value}],reveals:[]}} : {}),"
    : ''
  if (hasRulings) {
    applyRuling = `const changes=[]
    if(choice.ruling) {
      const rejection=settleRuling(choice.ruling,game,actor,${readsStatus ? 'truth' : 'null'},changes)
      if(rejection)return rejection
    }
    `
    appendEffect = "if(effect?.kind==='world') changes.push({holderId:null,key:effect.ref,value:effect.value})\n    "
    statusResult = '...(changes.length ? {status:{changes,reveals:[]}} : {}),'
  }
  return (
    header +
    JSON.stringify({ ...graph, layout: undefined }) +
    '\n' +
    (hasRulings ? rulingCode(sources) : '') +
    `function available(choice, scene${args}) {
${predicateBody}
  if (condition.kind === 'always') return true
${
  usesVariables
    ? `  if (condition.kind === 'world') return Object.hasOwn(known, condition.ref) && known[condition.ref] === condition.value
  if (condition.kind === 'local') {
    const scope = graph.variables.find(v => v.key === condition.ref).scope
    return game[scope === 'shared' ? 'public' : 'private'].variables[condition.ref] === condition.value
  }
`
    : ''
}${sceneCode}  return (condition.kind === 'present' ? scene.characterIds : scene.heldEntityIds).includes(condition.ref)
}
globalThis.activityScript = {
  definition: {
    title: graph.title, npcIds: [], readsScene: true,${readsStatus ? ' readsStatus: true,' : ''}
    ...(graph.opening ? { opening: graph.opening } : {}),
    operations: graph.choices.map(choice => ({
      id: choice.id, label: choice.label, requiresTurn: true,
      schema: { type: 'object', additionalProperties: false, properties: {} }
    }))
  },
  initialize({playerId}) {
${
  usesVariables
    ? `    const values = scope => Object.fromEntries((graph.variables ?? []).filter(v => v.scope === scope).map(v => [v.key,v.initial]))
`
    : ''
}    return { active: true, phase: 'choice', turn: playerId, round: 1,
      public: {statusText:graph.opening${usesVariables ? ",variables:values('shared')" : ''}}, private: {[playerId]:{${usesVariables ? "variables:values('private')" : ''}}}, internal: {${usesVariables ? "variables:values('internal')" : ''}} }
  },
  policy(view${presence ? ', actor' : ''}) {
    return { speech:'free', speechChoices:[], narration:true, move:true, interactions:[],
      operations:graph.choices.filter(choice => available(choice, ${presence ? '{...view.scene, actorId:actor}' : 'view.scene'}${usesVariables ? ', view.game, view.knownPublic ?? {}' : ''})).map(choice => choice.id) }
  },
  resolve(state, actor, operation, parameters, world${readsStatus ? ', truth' : ''}) {
    const choice = graph.choices.find(c => c.id === operation)
    const scene = { ${places ? 'locationId: world.locationId, ' : ''}${presence ? 'actorId: actor, ' : ''}characterIds: world.characterIds, heldEntityIds: world.items.current.filter(i => i.holderId === actor).map(i => i.entityId) }
    if (!choice || !available(choice, scene${usesVariables ? ', {...state.game, private:state.game.private[actor]}, ' + (readsStatus ? 'truth.public' : '{}') : ''})) return {rejectReason:'条件已改变，请重新选择。'}
    const active = choice.next === 'stay'
${
  usesVariables
    ? `    const game = state.game
    ${applyRuling}const effect = choice.effect
    if (effect?.kind === 'local') {
      const scope = graph.variables.find(v => v.key === effect.ref).scope
      const group = scope === 'shared' ? game.public : scope === 'private' ? game.private[actor] : game.internal
      group.variables = {...group.variables, [effect.ref]:effect.value}
    }
`
    : ''
}    ${appendEffect}return { ${statusResult}game:{...state.game, active, turn:active ? actor : null, phase:active ? 'choice' : 'ended',
      round:state.game.round+1, public:{...state.game.public,statusText:choice.result}},
      description:choice.result, audience:'self', ...(choice.speech ? {playerExpression:{text:choice.speech}} : {}) }
  },
  schedule() { return {kind:'wait'} },
  onOutcome() { return {kind:'wait'} }
}
`
  )
}

/** Verify the complete generated file before replacing it in a new export. */
export function generatedActivity(source: string): EditorGraph | undefined {
  const normalized = source.replaceAll('\r\n', '\n')
  if (!normalized.startsWith(header)) return undefined
  const line = normalized.slice(header.length).split('\n', 1)[0]!
  try {
    const graph = parseGraph(JSON.parse(line))
    const second = normalized.slice(header.length + line.length + 1).split('\n', 1)[0]!
    const sources = second.startsWith(sourcesMarker) ? JSON.parse(second.slice(sourcesMarker.length)) : {}
    return activityScript(graph, sources) === normalized ? graph : undefined
  } catch {
    return undefined
  }
}
