/** Authorized query/identity projection, ported from queries.py and retrieval_text.py. */
import type { WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import { checkSources, compareText, list, object, rows, same, text } from './archive.ts'

export const ID = /^(?:character|entity|location):[a-z0-9_-]+$/
export const RULE = 'authorized-identity-template/v1'
export const record = (v: WorldJsonValue | undefined): Record<string, WorldJsonValue> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? object(v) : {}
const pyTruthy = (v: WorldJsonValue | undefined): boolean =>
  v !== undefined &&
  v !== null &&
  (typeof v === 'boolean'
    ? v
    : typeof v === 'number'
      ? v !== 0
      : typeof v === 'string'
        ? v.length > 0
        : Array.isArray(v)
          ? v.length > 0
          : Object.keys(v).length > 0)
export const unique = (v: string[]): string[] => [...new Set(v)]
export const sorted = (v: string[]): string[] => unique(v).sort(compareText)
export const contentLength = (v: string): number => [...v].filter(c => /[\p{L}\p{N}]/u.test(c)).length
const PYTHON_SPACE = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/
const PYTHON_SPACES = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g
export const trimText = (value: string): string =>
  value.replace(new RegExp('^' + PYTHON_SPACE.source + '+|' + PYTHON_SPACE.source + '+$', 'g'), '')
export const normalizeWhitespace = (value: string): string => value.replace(PYTHON_SPACES, ' ').replace(/^ +| +$/g, '')
export const caseFold = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[ßẞ]/g, 'ss')
    .replaceAll('ς', 'σ')
    .replaceAll('ſ', 's')
    .replace(/[ﬀ-ﬆ]/g, c => ({ ﬀ: 'ff', ﬁ: 'fi', ﬂ: 'fl', ﬃ: 'ffi', ﬄ: 'ffl', ﬅ: 'st', ﬆ: 'st' })[c]!)
const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function contextNames(context: WorldJsonObject): WorldJsonObject[] {
  return [record(context.character), ...rows(record(context.scene).people ?? [])].filter(
    p => typeof p.characterId === 'string' && typeof p.name === 'string' && trimText(p.name),
  )
}
export function aliasTable(doc: WorldJsonObject, history: WorldJsonObject[] = []): WorldJsonObject {
  const sources = checkSources(doc),
    scope = object(doc.scope)
  const identities = new Set(sources.flatMap(s => text(s.text).match(/character:[a-zA-Z0-9_-]+/g) ?? [])),
    people = new Map<string, WorldJsonObject>()
  for (const entry of history) {
    const owner = object(entry.scope)
    if (!same(owner.worldAddress!, scope.worldAddress!) || owner.characterId !== scope.characterId)
      throw new Error('Alias history crosses character or world')
    if (Number(entry.worldSeq) > Number(scope.asOfWorldSeq)) continue
    for (const person of rows(entry.people)) {
      const id = text(person.characterId),
        name = text(person.name)
      if (!/^character:[a-zA-Z0-9_-]+$/.test(id) || !trimText(name)) continue
      const witnesses = sources
        .filter(s => text(s.text).includes(name) || text(s.text).includes(id))
        .map(s => s.sourceId!)
      if (!witnesses.length) continue
      const key = JSON.stringify([id, name]),
        old = people.get(key)
      people.set(key, {
        characterId: id,
        name,
        knownByWorldSeq: Math.min(Number(entry.worldSeq), Number(old?.knownByWorldSeq ?? entry.worldSeq)),
        sourceIds: witnesses,
      })
      identities.add(id)
    }
  }
  return {
    rule: RULE,
    scope,
    people: [...people.values()].sort(
      (a, b) => compareText(text(a.characterId), text(b.characterId)) || compareText(text(a.name), text(b.name)),
    ),
    characterIds: sorted([...identities]),
  }
}
export function clean(value: string, table: WorldJsonObject): string {
  const names = new Set(rows(table.people).map(p => text(p.name)))
  const order = (a: string, b: string) => [...b].length - [...a].length || compareText(a, b)
  for (const id of list(table.characterIds).map(text).sort(order)) {
    value = value.replace(new RegExp(escape(id) + '(?![a-zA-Z0-9_-])', 'g'), ' ')
    names.add(id.split(':').at(-1)!)
  }
  for (const name of [...names].sort(order))
    value = /^[\x00-\x7f]*$/.test(name)
      ? value.replace(new RegExp('(?<![a-zA-Z0-9_])' + escape(name) + '(?![a-zA-Z0-9_])', 'g'), ' ')
      : value.replaceAll(name, ' ')
  value = value
    .replaceAll('观察到行动结果：', '')
    .replaceAll('外显叙述：', '')
    .replaceAll('尝试未成功：', '未成功：')
    .replaceAll('结果未提供的行动记录：', '结果未提供：')
  while (value.startsWith('【主观认识，可修正】')) value = value.slice('【主观认识，可修正】'.length)
  return value
    .replace(new RegExp('([、,，])(?:' + PYTHON_SPACE.source + '*[、,，])+', 'g'), '$1')
    .replace(PYTHON_SPACES, ' ')
    .replace(/^ +| +$/g, '')
    .replace(/^[、,，:：;； ]+/, '')
}
export function lexicalTerms(value: string): string[] {
  const folded = caseFold(value)
  return (folded.match(/[\u3400-\u9fff]+|[a-z0-9]+(?:[-_][a-z0-9]+)*/g) ?? []).flatMap(word =>
    /^[\u3400-\u9fff]+$/.test(word) && word.length > 1
      ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))
      : [word],
  )
}
export function actionText(content: WorldJsonObject, names: Map<string, string>): string {
  const name = (id: WorldJsonValue | undefined) =>
    names.get(String(id)) ??
    String(id ?? '')
      .split(':')
      .at(-1)!
      .replaceAll('-', ' ')
  const actor = name(content.actorId),
    prefix =
      content.status === 'rejected'
        ? '尝试未成功：'
        : content.status === 'accepted'
          ? '观察到行动结果：'
          : '结果未提供的行动记录：'
  if (content.movement && typeof content.movement === 'object' && !Array.isArray(content.movement)) {
    const move = object(content.movement),
      parts: string[] = []
    if (move.fromLocationId) parts.push('离开' + name(move.fromLocationId))
    if (move.toLocationId) parts.push('进入' + name(move.toLocationId))
    return parts.length ? prefix + actor + '，' + parts.join('，') : ''
  }
  if (content.interaction && typeof content.interaction === 'object' && !Array.isArray(content.interaction)) {
    const interaction = object(content.interaction)
    return (
      prefix +
      actor +
      '，' +
      name(interaction.interactionId) +
      '，对象' +
      name(pyTruthy(interaction.entityId) ? interaction.entityId : interaction.targetRef)
    )
  }
  return ''
}
export function bounded(
  value: string,
  count: (v: string) => number,
  limit = 256,
): { value: string; count: number; clipped: boolean } {
  const size = count(value)
  if (size <= limit) return { value, count: size, clipped: false }
  const chars = [...value]
  let lo = 0,
    hi = chars.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (count(chars.slice(0, mid).join('')) <= limit) lo = mid
    else hi = mid - 1
  }
  const result = chars.slice(0, lo).join('')
  return { value: result, count: count(result), clipped: true }
}
export function queryProjection(
  request: WorldJsonObject,
  aliases: WorldJsonObject | undefined,
  count: (v: string) => number,
): WorldJsonObject {
  const context = object(request.context),
    scene = record(context.scene),
    names = new Map<string, string>()
  // Current item objects are not an additional stimulus or source of private names.
  const items = Array.isArray(context.items) ? rows(context.items) : []
  for (const obj of [record(context.character), ...rows(scene.people ?? []), ...items]) {
    const id = pyTruthy(obj.characterId) ? obj.characterId : pyTruthy(obj.entityId) ? obj.entityId : obj.id
    if (id && typeof obj.name === 'string') names.set(text(id), obj.name)
  }
  if (aliases) {
    if (object(aliases.scope).characterId !== record(context.character).characterId)
      throw new Error('Query alias table belongs to another character')
    for (const person of rows(aliases.people))
      if (!names.has(text(person.characterId))) names.set(text(person.characterId), text(person.name))
  }
  if (scene.locationId && scene.name) names.set(text(scene.locationId), text(scene.name))
  const chunks: string[] = [],
    lexical: string[] = [],
    entities = new Map<string, Set<string>>(),
    objectIds = new Set<string>()
  const stimulus = list(context.stimulus ?? [])
  let onlyMovement = stimulus.length > 0,
    onlyObjects = stimulus.length > 0
  const entity = (id: WorldJsonValue | undefined, role: string) => {
    if (typeof id === 'string' && ID.test(id)) {
      const roles = entities.get(id) ?? new Set<string>()
      roles.add(role)
      entities.set(id, roles)
    }
  }
  const explicit = record(request.recallEvidence).query
  if (typeof explicit === 'string') {
    chunks.push(trimText(explicit))
    lexical.push(trimText(explicit))
  } else
    for (const item of stimulus) {
      const itemObject = record(item),
        value = 'value' in itemObject ? itemObject.value : item,
        valueObject = record(value),
        content = typeof value === 'string' ? value : 'content' in valueObject ? valueObject.content : {}
      if (typeof content === 'string') {
        onlyMovement = false
        onlyObjects = false
        chunks.push(content)
        lexical.push(content)
        continue
      }
      if (!content || typeof content !== 'object' || Array.isArray(content)) {
        onlyMovement = false
        onlyObjects = false
        continue
      }
      const c = object(content),
        interaction = record(c.interaction),
        target = record(interaction.targetRef)
      onlyMovement =
        onlyMovement &&
        c.actionType === 'move' &&
        c.status === 'accepted' &&
        c.movement !== null &&
        typeof c.movement === 'object' &&
        !Array.isArray(c.movement)
      const id = pyTruthy(interaction.entityId)
        ? interaction.entityId
        : target.kind === 'entity'
          ? target.id
          : undefined
      const itemAction =
        c.actionType === 'interact' &&
        c.status === 'accepted' &&
        typeof id === 'string' &&
        id.startsWith('entity:') &&
        ID.test(id) &&
        !pyTruthy(c.speech)
      onlyObjects = onlyObjects && itemAction
      if (itemAction) {
        objectIds.add(id as string)
        entity(id, 'object:entityId')
      }
      entity(c.actorId, 'actor')
      if (c.speech && typeof c.speech === 'object' && !Array.isArray(c.speech)) {
        const speech = object(c.speech)
        entity(speech.characterId, 'actor')
        for (const recipient of list(speech.addresseeIds ?? [])) entity(recipient, 'addressee')
        const spoken = trimText(text(speech.text ?? ''))
        if (spoken) {
          chunks.push(spoken)
          lexical.push(spoken)
        } else if (typeof speech.narration === 'string' && trimText(speech.narration)) {
          chunks.push('外显叙述：' + trimText(speech.narration))
          lexical.push(trimText(speech.narration))
        }
      } else {
        const description =
          actionText(c, names) ||
          ['description', 'narration', 'resultDescription']
            .map(k => c[k])
            .find(v => typeof v === 'string' && trimText(v))
        if (description) {
          chunks.push(text(description))
          lexical.push(text(description))
        }
      }
      for (const [key, role] of [
        ['movement', 'location'],
        ['interaction', 'object'],
      ] as const)
        for (const field of ['characterId', 'entityId', 'fromLocationId', 'toLocationId', 'fromHolderId', 'toHolderId'])
          entity(record(c[key])[field], role + ':' + field)
    }
  for (const value of lexical) {
    for (const id of value.match(/(?:character|entity|location):[a-z0-9_-]+/g) ?? []) entity(id, 'mentioned')
    for (const [id, name] of names) if (name && value.includes(name)) entity(id, 'mentioned')
  }
  entity(scene.locationId, 'scene')
  let full = unique(chunks.map(trimText).filter(Boolean)).join(' '),
    keyword = unique(lexical.map(trimText).filter(Boolean)).join(' ')
  const raw = full
  if (aliases) {
    const current = contextNames(context),
      table = {
        ...aliases,
        people: [...rows(aliases.people), ...current],
        characterIds: sorted([...list(aliases.characterIds).map(text), ...current.map(o => text(o.characterId))]),
      }
    full = clean(full, table)
    keyword = clean(keyword, table)
  }
  const chars = contentLength(full),
    low = chars < 2
  if (low) keyword = ''
  const semantic = low ? { value: '', count: 0, clipped: false } : bounded(full, count)
  return {
    semanticQuery: semantic.value,
    keywordTerms: sorted(lexicalTerms(semantic.clipped ? semantic.value : keyword)),
    keywordText: semantic.clipped ? semantic.value : keyword,
    entitySeeds: [...entities]
      .sort(([a], [b]) => compareText(a, b))
      .map(([id, roles]) => ({ id, roles: sorted([...roles]) })),
    mode: semantic.value
      ? (onlyMovement || onlyObjects) && typeof explicit !== 'string'
        ? 'entity'
        : 'search'
      : 'skip',
    requiredEntityIds: onlyObjects && typeof explicit !== 'string' ? sorted([...objectIds]) : [],
    contentChars: chars,
    skipReason: semantic.value ? null : 'fewer than 2 searchable content characters',
    tokenCount: semantic.count,
    truncated: semantic.clipped,
    unboundedText: full,
    originalText: raw,
    ...(aliases ? { retrievalTextRule: aliases.rule! } : {}),
    origin: typeof explicit === 'string' ? 'explicit recall' : 'current authorized stimulus only',
    recentObservationsUsed: 0,
  }
}
