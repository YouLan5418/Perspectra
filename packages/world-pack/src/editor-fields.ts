export type Scalar = boolean | number | string
export type VariableScope = 'world' | 'shared' | 'private' | 'internal'
export interface EditorVariable {
  key: string
  label: string
  type: 'boolean' | 'number' | 'string'
  initial: Scalar
  options?: string[]
}
export interface LocalVariable extends EditorVariable {
  scope: Exclude<VariableScope, 'world'>
}
export interface WorldVariableDefinition extends EditorVariable {
  alwaysKnown?: boolean
}
export interface WorldVariable extends WorldVariableDefinition {
  locations?: readonly string[]
  editable: boolean
  readable: boolean
  writable: boolean
  activities?: readonly string[]
}
export interface VariableUse {
  kind: 'world' | 'local'
  ref: string
  value: Scalar
}
export type ConditionPredicate =
  | { kind: 'present' | 'location'; ref: string; negate?: true }
  | { kind: 'held' | 'party'; ref: string }
  | { kind: 'alone' }
  | VariableUse
export type ConditionLeaf = { kind: 'always' } | ConditionPredicate
export const conditionCatalog = {
  present: 'characters',
  party: 'partyCharacters',
  location: 'locations',
  held: 'items',
} as const
export type ChoiceCondition = ConditionLeaf | { kind: 'all' | 'any'; conditions: ConditionPredicate[] }
export function conditionLeaves(condition: ChoiceCondition): ConditionLeaf[] {
  return 'conditions' in condition ? condition.conditions : [condition]
}
export function eventVariables(variables: WorldVariable[]) {
  return variables.filter(v => v.type === 'boolean' && v.writable && !v.activities)
}
export function variableCandidates(
  world: WorldVariable[],
  local: LocalVariable[],
  activity: string,
  use: 'condition' | 'effect',
) {
  return [
    ...world
      .filter(v =>
        use === 'condition' ? v.readable : v.writable && (!v.activities || v.activities.includes(activity)),
      )
      .map(v => ({ ...v, kind: 'world' as const })),
    ...local.filter(v => use === 'effect' || v.scope !== 'internal').map(v => ({ ...v, kind: 'local' as const })),
  ]
}
export function rulingTargets(world: WorldVariable[], local: LocalVariable[], activity: string) {
  return variableCandidates(world, local, activity, 'effect').filter(v =>
    v.kind === 'world' ? v.readable : v.scope !== 'internal',
  )
}
export function acceptsVariableValue(v: Pick<EditorVariable, 'type' | 'options'>, value: unknown): value is Scalar {
  return (
    typeof value === v.type &&
    (typeof value !== 'number' || (Number.isSafeInteger(value) && !Object.is(value, -0))) &&
    (typeof value !== 'string' || (value.length <= 2000 && (!v.options || v.options.includes(value))))
  )
}
export function variableKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(key) || key === 'constructor')
    throw new TypeError('变量键须为小写字母、数字或连字符')
  return key
}
export function parseVariable(input: unknown): EditorVariable {
  const v = input as EditorVariable
  if (
    !v ||
    typeof v.label !== 'string' ||
    !v.label.trim() ||
    v.label.length > 80 ||
    !['boolean', 'number', 'string'].includes(v.type)
  )
    throw new TypeError('请填写变量键、名称和类型')
  if (
    v.options !== undefined &&
    (v.type !== 'string' ||
      !Array.isArray(v.options) ||
      !v.options.length ||
      v.options.length > 64 ||
      v.options.some(s => typeof s !== 'string' || !s.trim() || s.length > 120) ||
      new Set(v.options).size !== v.options.length)
  )
    throw new TypeError('枚举选项须为不重复的非空文字')
  if (!acceptsVariableValue(v, v.initial)) throw new TypeError('变量初值不符合类型或枚举：' + v.label)
  return {
    key: variableKey(v.key),
    label: v.label,
    type: v.type,
    initial: v.initial,
    ...(v.options ? { options: v.options } : {}),
  }
}

export function parseWorldVariable(input: unknown): WorldVariableDefinition {
  const v = parseVariable(input),
    known = (input as WorldVariableDefinition).alwaysKnown
  if (known !== undefined && typeof known !== 'boolean') throw new TypeError('请指定公共变量的可见性')
  return { ...v, ...(known === false ? { alwaysKnown: false } : {}) }
}

/** Native knowledge conditions for the simple public-variable equality control. */
export function knowledgeWhen(key: string, value: Scalar) {
  return {
    type: 'object',
    required: ['public'],
    properties: { public: { type: 'object', required: [key], properties: { [key]: { const: value } } } },
  }
}
export function knowledgeEquality(when: unknown): { key: string; value: Scalar } | undefined {
  if (!when || typeof when !== 'object') return
  const s = when as ReturnType<typeof knowledgeWhen>
  const key = s.properties?.public?.required?.[0]
  if (typeof key !== 'string') return
  const value = s.properties.public.properties?.[key]?.const
  if (!['boolean', 'string', 'number'].includes(typeof value)) return
  // Recognize only the exact generated structure, independent of object member order.
  const equal = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b))
      return false
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.entries(a).every(([k, v]) => Object.hasOwn(b, k) && equal(v, (b as Record<string, unknown>)[k]))
    )
  }
  return equal(s, knowledgeWhen(key, value!)) ? { key, value: value! } : undefined
}

/** Author form definitions and reference selection shared by the browser and the headless editor. */
export type RecordKind = 'character' | 'location' | 'item' | 'scene' | 'slot'
export type Values = Record<string, string | string[]>
export interface WorldRecord {
  kind: RecordKind
  id: string
  name: string
  file: string
  values: Values
}
export interface WorldField {
  key: string
  label: string
  required?: boolean
  choices?: readonly string[]
  reference?: RecordKind
  many?: boolean
  long?: boolean
}
export const sections: Record<RecordKind, string> = {
  character: '角色',
  location: '地点',
  item: '物品',
  scene: '场景',
  slot: '玩家开局',
}
export const fields: Record<RecordKind, WorldField[]> = {
  character: [
    { key: 'displayName', label: '角色名', required: true },
    { key: 'initialLocationId', label: '初始地点', reference: 'location' },
    { key: 'pronouns', label: '称谓' },
    { key: 'portrayal.summary', label: '人设摘要', long: true },
    { key: 'portrayal.speakingStyle', label: '说话风格', long: true },
  ],
  location: [{ key: 'name', label: '地点名', required: true }],
  item: [
    { key: 'name', label: '物品名' },
    { key: 'kind', label: '物品种类', required: true },
    { key: 'locationId', label: '起始地点', required: true, reference: 'location' },
  ],
  scene: [
    { key: 'lifecycle', label: '开局状态', required: true, choices: ['created', 'active', 'closed'] },
    { key: 'locationId', label: '所在地点', reference: 'location' },
    { key: 'participantIds', label: '参与角色', required: true, reference: 'character', many: true },
  ],
  slot: [{ key: 'characterId', label: '玩家角色', required: true, reference: 'character' }],
}
export const choiceNames: Record<string, string> = {
  manual: '玩家控制',
  scripted: '角色自主',
  created: '尚未启用',
  active: '开局启用',
  closed: '已关闭',
}
export const kinds = Object.keys(sections) as RecordKind[]
export function recordKind(v: unknown): RecordKind {
  if (typeof v !== 'string' || !Object.hasOwn(sections, v)) throw new TypeError('未知记录类型')
  return v as RecordKind
}
export function initialValues(kind: RecordKind): Values {
  return Object.fromEntries(fields[kind].map(f => [f.key, f.many ? [] : (f.choices?.[0] ?? '')]))
}
export function referenceCandidates(records: WorldRecord[], kind: RecordKind, key: string) {
  const field = fields[kind].find(f => f.key === key)
  if (!field?.reference) throw new TypeError('字段不接受记录引用')
  return records.filter(r => r.kind === field.reference)
}
export function openScenesByLocation(records: WorldRecord[]) {
  const groups = new Map<string, WorldRecord[]>()
  for (const scene of records) {
    const location = scene.values.locationId
    if (scene.kind !== 'scene' || scene.values.lifecycle === 'closed' || typeof location !== 'string' || !location)
      continue
    const group = groups.get(location)
    if (group) group.push(scene)
    else groups.set(location, [scene])
  }
  return groups
}
export function sceneBindingIssues(records: WorldRecord[]) {
  const names = new Map(records.filter(r => r.kind === 'location').map(r => [r.id, r.name]))
  return [...openScenesByLocation(records)]
    .filter(([, scenes]) => scenes.length > 1)
    .map(([locationId, scenes]) => ({
      locationId,
      locationName: names.get(locationId) ?? locationId,
      scenes: scenes.map(s => ({ id: s.id, lifecycle: String(s.values.lifecycle) })),
    }))
}
export type SceneBindingIssue = ReturnType<typeof sceneBindingIssues>[number]
export interface OpeningLocationIssue {
  characterId: string
  characterName: string
  initialLocation: string
  sceneId: string
  sceneName: string
  sceneLocation: string
}
export function openingLocationIssues(records: WorldRecord[]): OpeningLocationIssue[] {
  const actors = new Map(records.filter(r => r.kind === 'character').map(r => [r.id, r]))
  const places = new Map(records.filter(r => r.kind === 'location').map(r => [r.id, r.name]))
  const issues: OpeningLocationIssue[] = []
  for (const scene of records) {
    const { lifecycle, locationId, participantIds } = scene.values
    if (
      scene.kind !== 'scene' ||
      lifecycle !== 'active' ||
      typeof locationId !== 'string' ||
      !locationId ||
      !Array.isArray(participantIds)
    )
      continue
    for (const id of participantIds) {
      const actor = actors.get(id)
      if (!actor || actor.values.initialLocationId === locationId) continue
      const start = String(actor.values.initialLocationId ?? '')
      issues.push({
        characterId: id,
        characterName: actor.name,
        initialLocation: places.get(start) ?? (start || '未指定'),
        sceneId: scene.id,
        sceneName: scene.id || '新场景',
        sceneLocation: places.get(locationId) ?? locationId,
      })
    }
  }
  return issues
}

export function referencesTo(records: WorldRecord[], kind: RecordKind, id: string) {
  return records.flatMap(r =>
    fields[r.kind]
      .filter(
        f =>
          f.reference === kind &&
          (Array.isArray(r.values[f.key]) ? (r.values[f.key] as string[]).includes(id) : r.values[f.key] === id),
      )
      .map(f => ({ kind: r.kind, id: r.id, name: r.name, field: f.key, label: f.label })),
  )
}
