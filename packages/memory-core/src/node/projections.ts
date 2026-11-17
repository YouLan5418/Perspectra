import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import {
  activityMetadata,
  checkSources,
  compareText,
  list,
  object,
  rows,
  same,
  sourceRef,
  text,
  unionRefs,
  validateUnits,
} from './archive.ts'
import { actionText, aliasTable, clean, contentLength, ID, record, RULE, sorted } from './queries.ts'

export function archive(doc: WorldJsonObject) {
  const units = validateUnits(doc),
    sources = new Map(checkSources(doc).map(s => [text(s.sourceId), s]))
  for (const unit of units)
    for (const ref of rows(unit.sourceRefs)) {
      const source = sources.get(text(ref.sourceId))
      if (!source || !same(sourceRef(source), ref)) throw new Error('Unit reference differs from authorized source')
    }
  for (const source of sources.values())
    if (!Number.isSafeInteger(source.knownTick) || Number(source.knownTick) < 0)
      throw new Error('Source lacks authorized knowledge tick')
  return { byId: new Map(units.filter(u => u.memoryLevel).map(u => [text(u.id), u])), sources }
}
export function atomSearchText(atom: WorldJsonObject): string {
  const evidence = object(atom.evidence)
  if (evidence.channel !== 'action') return text(evidence.quote)
  const value = object(JSON.parse(text(evidence.context)))
  const projected = actionText(value, new Map())
  return typeof value.resultDescription === 'string' ? (projected + ' ' + value.resultDescription).trim() : projected
}
export function entityRoles(atoms: WorldJsonObject[]): WorldJsonObject[] {
  const roles = new Map<string, Set<string>>()
  const add = (id: unknown, role: string) => {
    if (typeof id === 'string' && ID.test(id)) {
      const values = roles.get(id) ?? new Set<string>()
      values.add(role)
      roles.set(id, values)
    }
  }
  for (const atom of atoms) {
    const e = object(atom.evidence)
    add(e.actorId, 'actor')
    for (const id of list(atom.entities ?? [])) add(id, 'mentioned')
    if (e.channel === 'action') {
      const value = object(JSON.parse(text(e.context)))
      for (const key of ['movement', 'interaction'])
        for (const [field, id] of Object.entries(record(value[key])))
          if (
            ['entityId', 'fromLocationId', 'toLocationId', 'fromHolderId', 'toHolderId', 'characterId'].includes(field)
          )
            add(id, key + ':' + field)
    }
  }
  return [...roles].sort(([a], [b]) => compareText(a, b)).map(([id, values]) => ({ id, roles: sorted([...values]) }))
}
export function associations(doc: WorldJsonObject) {
  const { byId, sources } = archive(doc),
    activities = new Map<string, Record<string, import('@perspectra/sdk/contracts').WorldJsonValue>>(),
    atomActivity = new Map<string, string>()
  for (const atom of byId.values()) {
    const e = record(atom.evidence)
    if (atom.memoryLevel !== 'event_atom' || e.channel !== 'action') continue
    const value = object(JSON.parse(text(e.context))),
      meta = activityMetadata(value)
    if (!meta) continue
    const id = text(meta.id),
      aid = text(atom.id)
    atomActivity.set(aid, id)
    const row = activities.get(id) ?? {
      activityId: id,
      atomIds: [],
      openingAtomId: null,
      endingAtomId: null,
      status: 'unknown',
    }
    row.atomIds = [...list(row.atomIds), aid]
    const seq = (ident: string) => Number(rows(byId.get(ident)!.sourceRefs)[0]!.worldSeq)
    if (meta.lifecycle === 'started' || meta.revision === 1)
      if (!row.openingAtomId || seq(aid) < seq(text(row.openingAtomId))) row.openingAtomId = aid
    const legacy =
      !('active' in meta) &&
      meta.phase === 'host-aborted' &&
      value.resultDescription === '玩家使用宿主逃生按钮中止活动，已解除本活动的交互限制与调度。'
    if (meta.active === false || legacy)
      if (!row.endingAtomId || seq(aid) > seq(text(row.endingAtomId))) {
        row.endingAtomId = aid
        row.status = 'ended'
      }
    activities.set(id, row)
  }
  return { byId, sources, activities, atomActivity }
}
export function bindActivity(doc: WorldJsonObject): WorldJsonObject {
  const { byId, activities, atomActivity } = associations(doc)
  return {
    ...doc,
    facts: rows(doc.facts).map(a => ({
      ...a,
      activityIds: atomActivity.has(text(a.id)) ? [atomActivity.get(text(a.id))!] : [],
    })),
    episodes: rows(doc.episodes ?? []).map(e => ({
      ...e,
      activityLinks: sorted(
        list(e.eventAtomIds)
          .map(text)
          .filter(i => atomActivity.has(i))
          .map(i => atomActivity.get(i)!),
      ).map(id => {
        const row = activities.get(id)!,
          { atomIds: _, ...rest } = row
        return {
          ...rest,
          sourceRefs: unionRefs(
            [row.openingAtomId, row.endingAtomId]
              .filter((v): v is string => typeof v === 'string')
              .map(i => byId.get(i)!),
          ),
        }
      }),
    })),
  }
}
export function retrievalProjection(
  doc: WorldJsonObject,
  count: (v: string) => number,
  history: WorldJsonObject[] = [],
  maxTokens = 220,
): WorldJsonObject {
  const { byId, atomActivity } = associations(doc),
    aliases = aliasTable(doc, history),
    views: WorldJsonObject[] = []
  const add = (unit: WorldJsonObject, atoms: WorldJsonObject[], value: string) => {
    while (value) {
      const chars = [...value]
      let end = chars.length
      if (count(value) > maxTokens) {
        let lo = 1,
          hi = end
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2)
          if (count(chars.slice(0, mid).join('')) <= maxTokens) lo = mid
          else hi = mid - 1
        }
        end = lo
      }
      const piece = chars.slice(0, end).join('')
      value = chars.slice(end).join('')
      if (count(piece) > maxTokens) throw new Error('Search token budget too small')
      const cleaned = clean(piece, aliases)
      if (contentLength(cleaned) < 2) continue
      const roles = new Map(entityRoles(atoms).map(r => [text(r.id), new Set(list(r.roles).map(text))]))
      for (const person of rows(aliases.people))
        if (piece.includes(text(person.name))) {
          const role = roles.get(text(person.characterId)) ?? new Set<string>()
          role.add('mentioned')
          roles.set(text(person.characterId), role)
        }
      const entityRows = [...roles]
        .sort(([a], [b]) => compareText(a, b))
        .map(([id, values]) => ({ id, roles: sorted([...values]) }))
      views.push({
        id: 'retrieval:' + views.length,
        kind: unit.kind!,
        retrievalProjection: true,
        memoryId: unit.id!,
        projectionLevel: unit.memoryLevel!,
        atomIds: atoms.map(a => a.id!),
        activityIds: sorted([
          ...new Set(atoms.map(a => atomActivity.get(text(a.id))).filter((id): id is string => id !== undefined)),
        ]),
        text: piece,
        retrievalText: cleaned,
        retrievalTextRule: RULE,
        sourceRefs: atoms.length ? unionRefs(atoms) : unit.sourceRefs!,
        channels: sorted(atoms.map(a => text(object(a.evidence).channel))),
        entities: entityRows.map(r => r.id),
        entityRoles: entityRows,
        searchTokens: count(piece),
      })
    }
  }
  for (const unit of byId.values()) {
    if (unit.memoryLevel === 'event_atom') add(unit, [unit], atomSearchText(unit))
    else if (unit.memoryLevel === 'episode') {
      let chunk: WorldJsonObject[] = [],
        texts: string[] = []
      for (const id of list(unit.eventAtomIds).map(text)) {
        const atom = byId.get(id)!
        const value = atomSearchText(atom)
        if (contentLength(clean(value, aliases)) < 2) continue
        if (texts.length && count([...texts, value].join('\n')) > maxTokens) {
          add(unit, chunk, texts.join('\n'))
          chunk = []
          texts = []
        }
        chunk.push(atom)
        texts.push(value)
      }
      if (texts.length) add(unit, chunk, texts.join('\n'))
    } else if (unit.memoryLevel === 'observation')
      add(
        unit,
        list(unit.sourceFactIds)
          .map(text)
          .map(i => byId.get(i)!),
        text(unit.text).replace(/^(?:【主观认识，可修正】)+/, ''),
      )
  }
  return {
    scope: doc.scope!,
    sources: doc.sources!,
    representations: [],
    retrievalAliases: aliases,
    facts: views.filter(v => v.kind === 'fact'),
    episodes: views.filter(v => v.kind === 'episode'),
    observations: views.filter(v => v.kind === 'observation'),
  }
}
