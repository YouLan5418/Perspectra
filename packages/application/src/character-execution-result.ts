import type { CharacterId, WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { currentEntityState, type CompiledWorldManifest, type RulebookEvent } from '@harness-world/kernel'

const object = (value: WorldJsonValue | undefined): WorldJsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WorldJsonObject : undefined

export const expressionAfterExecution = '本次执行已经结束。现在只能自由表达这次结果后的反应，或 abstain。触碰、翻页、临时托起查看或暂放桌上不自动改变保管关系。未执行的后续移动、取得保管、转交保管或解除保管尚未发生；不能在对白或叙述中写成已经完成。若想继续改变受控状态，在下一次可执行决策中提出。'

/** Domain feedback, not dialogue generation. Never infer refusal/consent from a permission code. */
export function characterExecutionResult(input: {
  readonly manifest: CompiledWorldManifest
  readonly events: readonly RulebookEvent[]
  readonly actorId: CharacterId
  readonly action: { readonly actionType: string; readonly parameters: WorldJsonValue }
  readonly status: string
  readonly reason: string | null
}): WorldJsonObject {
  const { status, reason } = input
  const parameters = object(input.action.parameters)
  const target = object(parameters?.targetRef)
  if (status === 'accepted') {
    const definition = object(parameters?.definitionRef)?.id
    const verb = definition === 'base:take' ? '取得保管' : definition === 'base:give' ? '转交保管'
      : definition === 'base:drop' ? '解除个人保管并留在当前场所' : '执行交互'
    const actual = target?.kind === 'entity' && typeof target.id === 'string'
      ? `你刚刚成功${verb}（物品：${target.id}）。` : '这次行动已经成功执行。'
    const state = target?.kind === 'entity' && typeof target.id === 'string' ? currentEntityState(input.events, target.id) : undefined
    return { status, description: actual + (state?.holderId === input.actorId ? '该物品目前仍由你保管；不要求一直握在手里。' : '当前状态请以本次可见场景为准。') }
  }
  if (target?.kind === 'entity' && typeof target.id === 'string') {
    const state = currentEntityState(input.events, target.id)
    const lastChange = input.events.findLastIndex(event =>
      (event.eventType === 'entity.transferred' || event.eventType === 'entity.upsert' || event.eventType === 'entity.taken')
      && object(event.data)?.entityId === target.id)
    // Possession must be known through this character's own observation, not a global state lookup alone.
    const knowsHolder = input.events.some((event, index) => {
      const value = object(object(event.data)?.value)
      const transfer = object(object(value?.content)?.interaction)
      return index > lastChange && event.eventType === 'observation.upsert' && value?.observerId === input.actorId
        && transfer?.entityId === target.id && transfer?.toHolderId === state?.holderId
    })
    if ((reason === 'PARTICIPANT_NOT_AUTHORIZED' || reason === 'ITEM_NOT_AVAILABLE')
      && state?.holderId !== null && state?.holderId !== undefined && knowsHolder) {
      const holder = input.manifest.characters.find(character => character.characterId === state.holderId)
      return { status, description: `这个物品已经由${holder?.name ?? '你看到的保管人'}保管，你没有成功取得它的保管。` }
    }
  }
  const descriptions: Record<string, string> = {
    NOT_CO_LOCATED: '你和目标不在同一个地方，这次没有接触到目标。',
    NO_SHARED_SCENE: '你现在无法与目标直接互动，这次行动没有完成。',
    SCENE_UNAVAILABLE: '你目前没有能够进行这次互动的场景条件，互动没有发生。',
    ITEM_NOT_HELD: '这个物品不由你保管，你没能解除它的保管或转交给别人。',
    ITEM_NOT_AVAILABLE: '这个物品目前不是可以直接取得保管的状态，这次保管关系没有改变。',
    RECIPIENT_NOT_AVAILABLE: '对方目前无法接收这个物品，交付没有发生。',
    ACTOR_CANNOT_ACT: '你当前的状态无法完成这次行动。',
    CONTACT_NOT_ACTIVE: '你们之间没有正在持续的这次接触，因此没有需要解除的接触。',
    CONSENT_REQUIRED: '这次互动需要对方同意，目前尚未获得同意，因此没有发生。',
    CONSENT_DENIED: '对方没有同意这次互动，因此没有发生。',
    INTERACTION_NOT_BOUND: '你当前无法对这个目标使用所请求的互动方式，互动没有发生。',
    INVALID_INTERACTION_PARAMETERS: '这次请求没有明确指定可执行的互动和目标，尚未执行。',
    INVALID_INTERACTION_ARGUMENTS: '这次互动缺少有效的必要信息，尚未执行。',
    PARTICIPANT_NOT_AUTHORIZED: '你面前找不到可供这次操作的目标，或当前无法接触它；这次互动没有发生。',
  }
  return { status, description: descriptions[reason ?? '']
    ?? '这次请求没有执行成功；没有产生请求中的状态变化。目前没有可向你说明的进一步原因。' }
}
