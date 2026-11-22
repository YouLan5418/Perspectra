/** Field and reference data shared by the workbench and the editor CLI. */
export type ConfigValue = string | number | boolean | null | ConfigValue[] | ConfigObject
export interface ConfigObject {
  [key: string]: ConfigValue
}
export interface ConfigField {
  title?: string
  type?: string
  const?: string | number | boolean
  enum?: (string | number | boolean)[]
  properties?: Record<string, ConfigField>
  additionalProperties?: boolean | ConfigField
  required?: string[]
  oneOf?: ConfigField[]
  anyOf?: ConfigField[]
  items?: ConfigField
  prefixItems?: ConfigField[]
  default?: ConfigValue
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  minProperties?: number
  maxProperties?: number
  pattern?: string
  propertyNames?: ConfigField
}
export interface ConfigOption {
  id: string
  name: string
}
export interface ConfigRecords {
  characters: ConfigOption[]
  locations: ConfigOption[]
  items: ConfigOption[]
  player: string
  markdown?: string[]
  portrayalTerms?: ConfigOption[]
  activityMenus?: { id: string; name: string; operations: ConfigOption[] }[]
  operations?: ConfigOption[]
  images?: string[]
}
export type SetupKind = 'world' | 'portrayal' | 'memory' | 'cognition'
export type FormKind = 'rpg' | 'trpg' | 'communication' | 'autonomy' | 'stage' | 'components' | SetupKind
export function configObject(value: unknown): ConfigObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ConfigObject) : {}
}
export function configAt(root: ConfigObject, path: readonly string[]): ConfigValue | undefined {
  let node: ConfigValue | undefined = root
  for (const key of path) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined
    node = Array.isArray(node) ? node[Number(key)] : node[key]
  }
  return node
}
function entries(value: ConfigValue | undefined) {
  return Object.entries(configObject(value)).map(([id, value]) => ({
    id,
    name: String(configObject(value).label ?? configObject(value).name ?? id),
  }))
}
function records(value: ConfigValue | undefined, idKey: string) {
  return (Array.isArray(value) ? value : [])
    .map(configObject)
    .filter(r => typeof r[idKey] === 'string')
    .map(r => ({ id: String(r[idKey]), name: String(r.label ?? r.name ?? r[idKey]) }))
}
/** dictionary requests enumerate the allowable keys, other paths enumerate field values. */
export function configCandidates(
  mode: FormKind,
  config: ConfigObject,
  book: ConfigRecords,
  path: readonly string[],
  dictionary = false,
): ConfigOption[] | undefined {
  const [top, second] = path,
    last = path.at(-1),
    parent = path.at(-2),
    node = configObject(configAt(config, path.slice(0, -1)))
  function unusedChoices(choices: ConfigOption[]) {
    const values = configAt(config, path.slice(0, -1))
    if (!Array.isArray(values)) return choices
    const used = new Set(values.filter((_, i) => String(i) !== last))
    return choices.filter(c => !used.has(c.id))
  }
  if (mode === 'components') return
  if (mode === 'stage') {
    if (dictionary) return path.length === 1 && top === 'characters' ? book.characters : undefined
    if (top === 'autoplay' && last === 'activity') return (book.activityMenus ?? []).filter(a => a.operations.length)
    if (top === 'autoplay' && last === 'operation')
      return book.activityMenus?.find(a => a.id === node.activity)?.operations ?? []
    if (top !== 'characters' || !second) return
    const character = configObject(configAt(config, ['characters', second]))
    if (path.length === 3 && last === 'defaultExpression') return entries(character.expressions)
    if (path.length === 5 && path[2] === 'expressions' && last === 'sheet') return entries(character.sheets)
    if (path.length === 5 && path[2] === 'expressions' && last === 'cell') {
      const sheets = configObject(character.sheets)
      if (typeof node.sheet !== 'string' || !Object.hasOwn(sheets, node.sheet)) return []
      const sheet = configObject(sheets[node.sheet]),
        columns = Number(sheet.columns ?? 4),
        rows = Number(sheet.rows ?? 4)
      if (![columns, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 16)) return []
      return Array.from({ length: columns * rows }, (_, i) => ({
        id: String(i),
        name: '第 ' + (Math.floor(i / columns) + 1) + ' 行 · 第 ' + ((i % columns) + 1) + ' 列',
      }))
    }
    if (
      (path.length === 4 && ['sheets', 'expressions', 'poses'].includes(path[2]!)) ||
      (path.length === 5 && ['sheets', 'expressions'].includes(path[2]!) && last === 'image')
    )
      return (book.images ?? []).map(id => ({ id, name: id.slice('portraits/'.length) }))
    return
  }
  if (mode === 'portrayal')
    return !dictionary && path.length === 1 && top === 'backgroundTextRef'
      ? (book.markdown ?? []).map(id => ({ id, name: id }))
      : undefined
  if (mode === 'world')
    return !dictionary && top === 'initialFacts' && path.length === 4 && parent === 'initialAudience'
      ? unusedChoices(book.characters)
      : undefined
  if (mode === 'memory') return
  if (mode === 'autonomy') {
    if (dictionary || top !== 'characters') return
    if (path.length === 3 && last === 'characterId') {
      const roles = Array.isArray(config.characters) ? config.characters : []
      const other = new Set(roles.filter((_, i) => String(i) !== second).map(r => configObject(r).characterId))
      return book.characters.filter(c => c.id !== book.player && !other.has(c.id))
    }
    if (path.length === 4 && parent === 'locationIds') return unusedChoices(book.locations)
    if (path.length === 4 && parent === 'targetIds') return unusedChoices([...book.characters, ...book.items])
    if (path.length === 4 && parent === 'interactions') return unusedChoices(book.operations ?? [])
    if (path.length !== 5 || path[2] !== 'triggers') return
    if (last === 'definitionId') return book.operations ?? []
    if (last === 'activityKey') return (book.activityMenus ?? []).filter(a => a.operations.length)
    if (last === 'operation') return book.activityMenus?.find(a => a.id === node.activityKey)?.operations ?? []
    return
  }
  if (mode === 'communication') {
    if (top !== 'contacts') return
    if (dictionary && path.length === 1) return book.characters
    if (dictionary || !book.characters.some(c => c.id === second)) return
    const others = book.characters.filter(c => c.id !== second)
    if (path.length === 2) return others
    if (path.length === 3) return unusedChoices(others)
    return
  }
  if (mode === 'cognition') {
    if (dictionary) return
    if (path.length === 3 && last === 'target' && top === 'relationships') return book.characters
    const parentGoal = top === 'goals' && path.length === 3 && last === 'parentGoalKey'
    const basis =
      parent === 'basisKeys' &&
      (path.length === 4 || (top === 'innerTensions' && path[2] === 'poles' && path.length === 6))
    const target =
      (top === 'affects' && path.length === 3 && last === 'targetKey') ||
      (top === 'goals' && path.length === 4 && (parent === 'targetKeys' || parent === 'blockerKeys'))
    if (!basis && !parentGoal && !target) return
    const rows = Object.values(config)
      .flatMap(value => (Array.isArray(value) ? value.map(configObject) : []))
      .filter(r => typeof r.key === 'string')
    const named = (r: ConfigObject) => ({
      id: String(r.key),
      name: String(r.title ?? r.summary ?? (typeof r.content === 'string' ? r.content : r.key)),
    })
    if (target) return unusedChoices([...rows.map(named), ...book.characters, ...book.locations, ...book.items])
    // A basis cannot depend, even indirectly, on the entry being edited.
    const children = new Map<string, string[]>()
    for (const r of rows) {
      const poles = Array.isArray(r.poles) ? r.poles.map(configObject) : []
      for (const dep of [
        r.parentGoalKey,
        ...[r, ...poles].flatMap(p => (Array.isArray(p.basisKeys) ? p.basisKeys : [])),
      ]) {
        if (typeof dep !== 'string') continue
        const list = children.get(dep) ?? []
        list.push(String(r.key))
        children.set(dep, list)
      }
    }
    const blocked = new Set<string>(),
      queue = [String(configObject(configAt(config, path.slice(0, 2))).key ?? '')]
    while (queue.length) {
      const key = queue.pop()!
      if (blocked.has(key)) continue
      blocked.add(key)
      queue.push(...(children.get(key) ?? []))
    }
    const goalKeys = new Set(
      parentGoal && Array.isArray(config.goals) ? config.goals.map(r => configObject(r).key) : [],
    )
    const local = rows.filter(r => !blocked.has(String(r.key)))
    if (parentGoal) local.sort((a, b) => Number(goalKeys.has(b.key)) - Number(goalKeys.has(a.key)))
    return unusedChoices([...local.map(named), ...(book.portrayalTerms ?? [])])
  }
  if (mode === 'trpg') {
    if ((dictionary && path.length === 1 && top === 'characters') || (top === 'hosts' && path.length === 2))
      return book.characters.filter(c => c.id !== book.player)
    if (dictionary && top === 'characters' && path.length === 3)
      return records(configAt(config, ['sheet', last!]), 'key')
    if (top === 'scenarios' && path[2] === 'content' && last === 'location') {
      const content = configAt(config, path.slice(0, 3))
      return (Array.isArray(content) ? content : [])
        .map(configObject)
        .filter(c => c.kind === 'place' && (!node.public || c.public))
        .map(c => ({ id: String(c.name), name: String(c.name) }))
    }
    return
  }
  if (dictionary) {
    if (path.length === 1 && top === 'characters') return book.characters
    if (path.length === 1 && (top === 'equipment' || top === 'consumables')) return book.items
    if (last === 'stats' || last === 'restore' || last === 'cost')
      return records(config.stats, 'key').filter(s => last !== 'cost' || s.id !== 'hp')
    if (last === 'resourceCost' || (last === 'resources' && top !== 'battleValues'))
      return entries(configAt(config, ['battleValues', 'resources']))
    if (last === 'attributeModifiers' || (last === 'attributes' && top !== 'battleValues'))
      return entries(configAt(config, ['battleValues', 'attributes']))
    return
  }
  if (last === 'locationId' || last === 'to' || last === 'vault' || parent === 'locations') return book.locations
  if (last === 'holds' || last === 'chest' || parent === 'drops') return book.items
  if (last === 'leader') return book.characters.filter(c => Object.hasOwn(configObject(config.characters), c.id))
  if (last === 'characterId' && path.includes('scripted'))
    return book.characters.filter(c => c.id !== book.player && Object.hasOwn(configObject(config.characters), c.id))
  if (parent === 'enemies' && top === 'maps') return entries(config.enemies)
  if (parent === 'skills' && (top === 'characters' || top === 'enemies')) {
    const choices = Array.isArray(config.skills) ? config.skills.map(configObject) : []
    return records(
      choices.filter(s => top !== 'enemies' || !Object.keys(configObject(s.cost)).length),
      'id',
    )
  }
  if (last === 'skill' && path.includes('scripted')) {
    if (node.when !== 'encounter' && node.when !== 'turn') return []
    const skills = configAt(config, ['characters', String(node.characterId), 'skills'])
    return records(config.skills, 'id').filter(s => Array.isArray(skills) && skills.includes(s.id))
  }
  if (last === 'target' && path.includes('scripted')) {
    const map = configObject(configAt(config, ['maps', second!])),
      skill = (Array.isArray(config.skills) ? config.skills : []).map(configObject).find(s => s.id === node.skill)
    return skill?.target === 'opponent'
      ? entries(config.enemies).filter(e => Array.isArray(map.enemies) && map.enemies.includes(e.id))
      : []
  }
  if (last === 'onZeroStatus' || last === 'status') return entries(config.combatStatuses)
  if (last === 'resistance') return entries(configAt(config, ['battleValues', 'attributes']))
  if (last === 'key' && (node.scope === 'shared' || node.scope === 'actor' || node.scope === 'target'))
    return entries(
      configAt(config, [
        'battleValues',
        node.scope === 'shared' ? 'shared' : node.kind === 'attribute' ? 'attributes' : 'resources',
      ]),
    )
}
