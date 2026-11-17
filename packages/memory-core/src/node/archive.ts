/** Port of core.py / episode_core.py authorization and evidence checks.
 * These functions consume an already authorized snapshot; they never open a world store. */
import { canonicalizeWorldJson, type WorldJsonObject, type WorldJsonValue } from '@perspectra/sdk/contracts'

export function object(value: WorldJsonValue | undefined): Record<string, WorldJsonValue> {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid memory object')
  return value as Record<string, WorldJsonValue>
}
export function list(value: WorldJsonValue | undefined): WorldJsonValue[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid memory list')
  return value
}
export const rows = (value: WorldJsonValue | undefined): Record<string, WorldJsonValue>[] => list(value).map(object)
export function text(value: WorldJsonValue | undefined): string {
  if (typeof value !== 'string') throw new TypeError('Invalid memory text')
  return value
}
export const same = (a: WorldJsonValue, b: WorldJsonValue): boolean =>
  JSON.stringify(canonicalizeWorldJson(a)) === JSON.stringify(canonicalizeWorldJson(b))
export const compareText = (a: string, b: string): number => {
  const left = [...a],
    right = [...b]
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const delta = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!
    if (delta) return delta
  }
  return left.length - right.length
}
export const KINDS = new Set([
  'direct_observation',
  'observed_action',
  'reported_speech',
  'subjective_inference',
  'self_intention',
])
export const LABELS: Readonly<Record<string, string>> = {
  speech: '听到发言；所述内容未经独立核实',
  narration: '外显叙述；不是规则裁定结果',
  player_input: '原始玩家输入；不是行动成功证据',
  appearance: '观察到外显表现；不证明物品转移或移动',
  action: '本角色获准看到的行动结果',
  reported_speech: '转述来源；内容未经独立核实',
  self_intention: '自身意图；不代表已执行',
  subjective_inference: '已有主观推断；不是客观事实',
  direct_observation: '本角色的直接观察',
  observed_action: '本角色的行动观察；不补充未提供的执行结果',
}

export function checkScope(doc: WorldJsonObject): WorldJsonObject {
  const scope = object(doc.scope),
    address = object(scope.worldAddress)
  if (
    !same(Object.keys(address).sort(), ['branchId', 'tenantId', 'worldId']) ||
    !Object.values(address).every(v => typeof v === 'string' && v.length > 0)
  )
    throw new Error('Incomplete WorldAddress')
  if (typeof scope.characterId !== 'string' || !scope.characterId) throw new Error('Missing CharacterId')
  if (!Number.isSafeInteger(scope.asOfWorldSeq) || (scope.asOfWorldSeq as number) < 0)
    throw new Error('Invalid worldSeq')
  return scope
}
export function checkSources(doc: WorldJsonObject): WorldJsonObject[] {
  const scope = checkScope(doc),
    ids = new Set<string>()
  return rows(doc.sources).map(source => {
    for (const key of ['sourceId', 'sourceHash', 'epistemicKind', 'worldSeq', 'characterId', 'worldAddress', 'text'])
      if (!(key in source)) throw new Error('Missing source field: ' + key)
    if (source.characterId !== scope.characterId || !same(source.worldAddress!, scope.worldAddress!))
      throw new Error('Cross-character or cross-world source')
    if (
      !KINDS.has(text(source.epistemicKind)) ||
      !Number.isSafeInteger(source.worldSeq) ||
      (source.worldSeq as number) > (scope.asOfWorldSeq as number)
    )
      throw new Error('Invalid source epistemics or future seq')
    const id = text(source.sourceId)
    text(source.text)
    if (!id || !text(source.sourceHash) || ids.has(id)) throw new Error('Invalid or duplicate sourceId')
    ids.add(id)
    return source
  })
}
export function sourceRef(source: WorldJsonObject): WorldJsonObject {
  return Object.fromEntries(
    ['sourceId', 'sourceHash', 'epistemicKind', 'worldSeq', 'characterId', 'worldAddress'].map(k => [k, source[k]!]),
  )
}

/** Python's ensure_ascii=False JSON, including separator spaces used in utility budgets. */
export function memoryJson(value: WorldJsonValue, sortKeys = false): string {
  if (Array.isArray(value)) return '[' + value.map(v => memoryJson(v, sortKeys)).join(', ') + ']'
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort(sortKeys ? compareText : () => 0)
        .map(k => JSON.stringify(k) + ': ' + memoryJson(object(value)[k]!, sortKeys))
        .join(', ') +
      '}'
    )
  return JSON.stringify(value)
}
export const evidenceJson = (value: WorldJsonValue): string => memoryJson(value, true)

export function activityMetadata(value: WorldJsonObject): WorldJsonObject | null {
  if (value.status !== 'accepted') return null
  const result = value.resultMetadata
  const candidate =
    (result !== null && typeof result === 'object' && !Array.isArray(result) ? object(result).activity : null) ??
    value.activity
  if (candidate === undefined || candidate === null) return null
  const meta = object(candidate)
  if (
    typeof meta.id !== 'string' ||
    !/^activity:[a-z0-9_-]+$/.test(meta.id) ||
    !Number.isSafeInteger(meta.revision) ||
    (meta.revision as number) < 1 ||
    typeof meta.phase !== 'string' ||
    !Number.isSafeInteger(meta.round)
  )
    throw new Error('Invalid authorized activity metadata')
  if ('active' in meta && typeof meta.active !== 'boolean') throw new Error('Invalid activity active flag')
  if ('lifecycle' in meta && !['started', 'updated', 'ended'].includes(text(meta.lifecycle)))
    throw new Error('Invalid activity lifecycle')
  if (meta.lifecycle === 'ended' && meta.active !== false) throw new Error('End marker requires inactive result')
  return Object.fromEntries(
    ['id', 'revision', 'phase', 'round', 'active', 'lifecycle']
      .filter(k => k in meta)
      .map(k => [k, structuredClone(meta[k]!)]),
  )
}

export function segments(source: WorldJsonObject): WorldJsonObject[] {
  const content = text(source.text),
    id = text(source.sourceId)
  const matches = [
    ...content.matchAll(
      /(?:^|; )(?:(character:[a-z0-9_-]+) (said: |published narration \(not an adjudicated outcome\): |appeared: )|original player input \(interpretation evidence, not an adjudicated outcome\): )/g,
    ),
  ]
  if (matches[0]?.index === 0)
    return matches.flatMap((match, i) => {
      const context = content.slice(match.index! + match[0].length, matches[i + 1]?.index ?? content.length),
        token = match[2] ?? ''
      const channel =
        token === 'said: '
          ? 'speech'
          : token.startsWith('published')
            ? 'narration'
            : token === 'appeared: '
              ? 'appearance'
              : 'player_input'
      return context.trim() ? [{ id: id + '/part:' + i, channel, actorId: match[1] ?? null, context }] : []
    })
  if (source.epistemicKind === 'observed_action') {
    let value: WorldJsonValue
    try {
      value = JSON.parse(content) as WorldJsonValue
    } catch {
      value = null
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      ['accepted', 'rejected'].includes(String(object(value).status))
    ) {
      const record = object(value)
      const outcome = Object.fromEntries(
        ['actorId', 'actionType', 'status', 'movement', 'interaction']
          .filter(k => k in record)
          .map(k => [k, record[k]!]),
      )
      if (typeof record.resultDescription === 'string') outcome.resultDescription = record.resultDescription
      const activity = activityMetadata(record)
      if (activity !== null) outcome.activity = activity
      return [
        {
          id: id + '/part:0',
          channel: 'action',
          actorId: record.actorId ?? null,
          context: evidenceJson(outcome),
          executionStatus: record.status!,
        },
      ]
    }
  }
  return [{ id: id + '/part:0', channel: source.epistemicKind!, actorId: null, context: content }]
}
export function atomText(atom: WorldJsonObject): string {
  const evidence = object(atom.evidence),
    channel = text(evidence.channel),
    label = LABELS[channel]
  if (!label) throw new Error('Invalid evidence channel')
  let result = '【' + label + '】' + (evidence.actorId ? text(evidence.actorId) + '：' : '') + text(evidence.quote)
  if (evidence.quote !== evidence.context)
    result += '\n【完整引用语境；保留否定、条件和不确定性】' + text(evidence.context)
  return result
}
export function makeAtom(
  source: WorldJsonObject,
  segment: WorldJsonObject,
  quote: string,
  number: number,
): WorldJsonObject {
  const atom: WorldJsonObject = {
    id: 'atom:' + text(source.sourceId) + ':' + number,
    kind: 'fact',
    memoryLevel: 'event_atom',
    evidence: { ...segment, sourceId: source.sourceId!, quote },
    evidenceQuote: quote,
    sourceRefs: [sourceRef(source)],
    entities: [...new Set(quote.match(/(?:character|entity|location):[a-z0-9_-]+/g) ?? [])].sort(compareText),
  }
  return { ...atom, text: atomText(atom) }
}
export function unionRefs(atoms: readonly WorldJsonObject[]): WorldJsonObject[] {
  const refs = new Map<string, WorldJsonObject>()
  for (const atom of atoms) for (const ref of rows(atom.sourceRefs)) refs.set(text(ref.sourceId), structuredClone(ref))
  return [...refs.values()].sort(
    (a, b) => (a.worldSeq as number) - (b.worldSeq as number) || compareText(text(a.sourceId), text(b.sourceId)),
  )
}
export function episodeText(atoms: readonly WorldJsonObject[]): string {
  return (
    '【同一段经历的分组；各项证据独立，不表示全部行动已完成】\n' +
    atoms.map(a => '[' + text(a.id) + '] ' + text(a.text)).join('\n')
  )
}
function checkAtom(atom: WorldJsonObject, sources: Map<string, WorldJsonObject>): void {
  if (atom.kind !== 'fact' || atom.memoryLevel !== 'event_atom') throw new Error('Not an Event Atom')
  const refs = rows(atom.sourceRefs),
    source = sources.get(text(refs[0]?.sourceId))
  if (refs.length !== 1 || !source) throw new Error('Atom must cite one authorized source')
  const evidence = object(atom.evidence)
  if (!same(refs, [sourceRef(source)]) || evidence.sourceId !== source.sourceId)
    throw new Error('Atom source mapping mismatch')
  const segment = segments(source).find(s => s.id === evidence.id)
  if (!segment) throw new Error('Atom segment missing')
  if (Object.entries(segment).some(([k, v]) => !same(evidence[k] ?? null, v)))
    throw new Error('Atom evidence context or attribution changed')
  const quote = text(evidence.quote)
  if (!quote.trim() || !text(segment.context).includes(quote)) throw new Error('Atom quote not in evidence context')
  if (segment.channel === 'action' && quote !== segment.context)
    throw new Error('Action atom cannot omit execution status')
  if (atom.text !== atomText(atom) || atom.evidenceQuote !== quote) throw new Error('Atom text does not match evidence')
}
export function validateUnits(doc: WorldJsonObject): WorldJsonObject[] {
  const sources = new Map(checkSources(doc).map(s => [text(s.sourceId), s])),
    scope = checkScope(doc)
  const units = ['representations', 'facts', 'episodes', 'observations'].flatMap(k => rows(doc[k] ?? []))
  const ids = new Set<string>(),
    canonical = new Map(units.filter(u => u.memoryLevel === 'event_atom').map(u => [text(u.id), u]))
  for (const unit of units) {
    const id = text(unit.id)
    if (ids.has(id)) throw new Error('Duplicate unit id')
    ids.add(id)
    const refs = rows(unit.sourceRefs)
    if (!refs.length) throw new Error('Unit without source mapping')
    for (const ref of refs) {
      if (
        ref.characterId !== scope.characterId ||
        !same(ref.worldAddress!, scope.worldAddress!) ||
        !Number.isSafeInteger(ref.worldSeq) ||
        (ref.worldSeq as number) > (scope.asOfWorldSeq as number)
      )
        throw new Error('Unit crosses cognitive boundary')
      if (!text(ref.sourceId) || !text(ref.sourceHash) || !KINDS.has(text(ref.epistemicKind)))
        throw new Error('Incomplete source mapping')
    }
    if (unit.memoryLevel === 'event_atom') checkAtom(unit, sources)
    else if (unit.memoryLevel === 'episode' || unit.memoryLevel === 'observation') {
      const atoms = rows(unit.eventAtoms ?? []),
        atomIds = atoms.map(a => text(a.id))
      if (!atoms.length || new Set(atomIds).size !== atoms.length)
        throw new Error('Aggregate must contain distinct evidence atoms')
      for (const atom of atoms) {
        checkAtom(atom, sources)
        const lower = canonical.get(text(atom.id))
        if (
          lower &&
          ['id', 'text', 'evidence', 'evidenceQuote', 'sourceRefs'].some(k => !same(atom[k] ?? null, lower[k] ?? null))
        )
          throw new Error('Aggregate changed lower-level atom')
      }
      if (!same(unit.sourceRefs!, unionRefs(atoms)))
        throw new Error('Aggregate source mapping not equal to cited atoms')
      if (unit.memoryLevel === 'episode') {
        if (!same(unit.eventAtomIds!, atomIds) || unit.text !== episodeText(atoms))
          throw new Error('Episode cannot rewrite atom contents')
      } else {
        const support = list(unit.supportingAtomIds ?? []).map(text),
          counter = list(unit.contradictingAtomIds ?? []).map(text)
        if (
          !support.length ||
          support.some(i => counter.includes(i)) ||
          !same([...new Set(atomIds)].sort(compareText), [...new Set([...support, ...counter])].sort(compareText))
        )
          throw new Error('Observation evidence mismatch')
        if (!same(unit.sourceFactIds!, [...support, ...counter]) || !text(unit.text).startsWith('【主观认识，可修正】'))
          throw new Error('Observation lost its subjective/evidence framing')
        if (unit.epistemicKind !== 'subjective_inference') throw new Error('Observation must be subjective inference')
      }
    }
  }
  return units
}
