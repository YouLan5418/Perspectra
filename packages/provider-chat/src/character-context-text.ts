import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'

function isObject(value: WorldJsonValue | undefined): value is WorldJsonObject {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}
// These are host bookkeeping fields in authorized evidence, not action parameters.
// Never apply this list to scene objects, affordances, Activity or creator variables.
const evidenceMetadata = new Set(['actionId', 'observationId', 'observerId', 'sourceSeq', 'worldSeq',
  'sourceId', 'sourceIds', 'sourceHash', 'sourceMaxSeq', 'sourceFactIds', 'worldAddress',
  'asOfWorldSeq', 'bundleHash', 'operationId', 'eventRefs', 'validFromSeq', 'validToSeq',
  'sourceSpans'])
function evidence(value: WorldJsonValue): WorldJsonValue {
  if (Array.isArray(value)) return value.map(evidence)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !evidenceMetadata.has(key))
    .map(([key, item]) => [key, key === 'parameters' || key === 'arguments' ? item : evidence(item)]))
}
function cognitionText(cognition: WorldJsonObject): WorldJsonObject {
  return Object.fromEntries(Object.entries(cognition)
    .filter(([key]) => !['address', 'characterId', 'asOfWorldSeq', 'bundleHash'].includes(key))
    .map(([key, value]) => [key, Array.isArray(value) ? value.map(row => {
      if (!isObject(row) || !isObject(row.value)) return evidence(row)
      const { id: _id, characterId: _owner, ...rest } = row
      return evidence(rest)
    }) : evidence(value)]))
}
/** Final model-only presentation. Host requests, memory evidence and commits retain their original fields. */
export function characterRequestText(request: { readonly context: WorldJsonObject }): string {
  const { character, observations, selfObservations, cognition, memories, ...dynamic } = request.context
  const profile = isObject(character) ? Object.fromEntries(Object.entries(character)
    .filter(([key]) => key !== 'locationId')) : character
  const history: { seq: number; index: number; entry: WorldJsonObject }[] = []
  const append = (records: WorldJsonValue | undefined, kind: string) => {
    if (!Array.isArray(records)) return
    for (const record of records) {
      if (!isObject(record)) continue
      // Sequence is used solely to order already-authorized evidence; it is not sent to the model.
      const seq = typeof record.sourceSeq === 'number' ? record.sourceSeq : Number.MAX_SAFE_INTEGER
      const payload = kind === 'observed' ? record.value : record.content
      const { id: _id, observationId: _observationId, sourceSeq: _seq, ...fallback } = record
      history.push({ seq, index: history.length, entry: { kind, content: evidence(payload ?? fallback) } })
    }
  }
  append(observations, 'observed'); append(selfObservations, 'self')
  history.sort((left, right) => left.seq - right.seq || left.index - right.index)
  const context: WorldJsonObject = {
    ...(profile === undefined ? {} : { character: profile }),
    history: history.map(row => row.entry),
    ...(memories === undefined ? {} : { memories: Array.isArray(memories) ? memories.map(row => {
      if (!isObject(row)) return evidence(row)
      const { id: _id, memoryId: _memoryId, projectionId: _projectionId, ...rest } = row
      return evidence(rest)
    }) : evidence(memories) }),
    ...(isObject(cognition) ? { cognition: cognitionText(cognition) } : {}),
    ...dynamic,
    ...(dynamic.stimulus === undefined ? {} : { stimulus: evidence(dynamic.stimulus) }),
    ...(isObject(character) && character.locationId !== undefined ? { locationId: character.locationId } : {}),
  }
  const { context: _context, ...stage } = request
  return JSON.stringify({ context, ...stage,
    ...(!isObject((stage as WorldJsonObject).result) ? {} : { result: Object.fromEntries(
      Object.entries((stage as WorldJsonObject).result as WorldJsonObject)
        .filter(([key]) => !['operationId', 'eventRefs'].includes(key))) }),
    ...((stage as WorldJsonObject).recallEvidence === undefined ? {}
      : { recallEvidence: evidence((stage as WorldJsonObject).recallEvidence!) }),
  })
}
export const characterContextNote = 'context.history 是你本人获授权的经历，按发生顺序排列；kind=observed 表示获得的观察，kind=self 表示你自己已发表的表达。当前刺激在 stimulus，当前地点在 context.locationId；历史里的地点不代表当前位置。历史与记忆中的 sourceKind/epistemicKind 表示来源性质：听到的话不证明事实成立。context.cognition 是你的主观认识、目标和情绪，不能视为他人的知识或权威世界事实。'
