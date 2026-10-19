import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { characterActionExplanations, characterActionExplanationsNote } from './character-action-explanations.ts'

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
/** Presentation of already-authorized item rows only; never query the world to fill missing items. */
function itemBoundaries(items: WorldJsonValue | undefined, actorId: WorldJsonValue | undefined): WorldJsonValue | undefined {
  if (!isObject(items) || typeof actorId !== 'string' || !Array.isArray(items.current) || !Array.isArray(items.lastObserved)) return items
  return { ...items,
    current: items.current.map(row => {
      if (!isObject(row) || typeof row.entityId !== 'string'
        || (typeof row.holderId !== 'string' && row.holderId !== null)) return row
      return { ...row, narrativeBoundary: row.holderId === actorId
        ? '当前由你保管；无需一直握在手中，转交保管须经过交互成功结算。'
        : '当前不由你保管；不能客观描写你已从随身口袋取出，或已取得、转交其保管。' }
    }),
    lastObserved: items.lastObserved.map(row => isObject(row) && typeof row.entityId === 'string'
      ? { ...row, narrativeBoundary: '仅有上次观察，当前归属与位置未确认；不能把旧观察写成现在的客观事实。' } : row),
    narrativeBoundaryNote: '以上只约束当下客观的受控结果，不改变角色原有认识；仍可误认、说谎、回忆、假设或尝试。触碰、临时托起查看不等于取得或解除保管。未列出的物品不代表你已知其归属或位置，不能仅凭旧话或提及就补成当前可见事实。',
  }
}
/** Final model-only presentation. Host requests, memory evidence and commits retain their original fields. */
export function characterRequestText(request: { readonly context: WorldJsonObject; readonly canPerform?: boolean; readonly continuation?: boolean }): string {
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
    ...(dynamic.items === undefined ? {} : { items: itemBoundaries(dynamic.items, isObject(character) ? character.characterId : undefined)! }),
    ...(dynamic.recentExecutionEvidence === undefined ? {} : { recentExecutionEvidence: evidence(dynamic.recentExecutionEvidence) }),
    ...(dynamic.stimulus === undefined ? {} : { stimulus: evidence(dynamic.stimulus) }),
    ...(isObject(character) && character.locationId !== undefined ? { locationId: character.locationId } : {}),
  }
  const { context: _context, ...stage } = request
  const explanations = (request.canPerform ?? !request.continuation) ? characterActionExplanations(context) : []
  const result = (stage as WorldJsonObject).result
  const moved = isObject(result) && result.status === 'accepted' && isObject(result.action) && result.action.actionType === 'move'
  return JSON.stringify({ context: { ...context, ...(explanations.length ? { actionExplanations: explanations } : {}) }, ...stage,
    ...(!isObject((stage as WorldJsonObject).result) ? {} : { result: Object.fromEntries(
      Object.entries((stage as WorldJsonObject).result as WorldJsonObject)
        .filter(([key]) => !['operationId', 'eventRefs'].includes(key))) }),
    ...((stage as WorldJsonObject).recallEvidence === undefined ? {}
      : { recallEvidence: evidence((stage as WorldJsonObject).recallEvidence!) }),
    ...(moved ? { currentSceneAfterMove: { locationId: context.locationId ?? null,
      people: isObject(context.scene) ? context.scene.people ?? [] : [],
      instruction: '这是移动成功后的当前授权场景。离开不等于别人与你同行；不在此名单的人不能被描写成已经在身旁。历史谈话对象不代表现在在场。' } } : {}),
  })
}
export const characterContextNote = 'context.history 是你本人获授权的经历，按发生顺序排列；kind=observed 表示获得的观察，kind=self 表示你自己已发表的表达。当前刺激在 stimulus，当前地点在 context.locationId；历史里的地点不代表当前位置。历史与记忆中的 sourceKind/epistemicKind 表示来源性质：听到的话不证明事实成立。context.cognition 是你的主观认识、目标和情绪，不能视为他人的知识或权威世界事实。context.knownStatus 只列出你已确认过的状态值，未列出的状态你并不知道。' + characterActionExplanationsNote
