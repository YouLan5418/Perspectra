import type { WorldJsonObject } from '@harness-world/contracts'
import { actionGroupWireSchema, type ChatCall } from './wire.ts'

/** Reuse the existing definition-derived parameter schemas; only the decision shape changes. */
export function prototypeTurnCall(request: { readonly context: WorldJsonObject; readonly continuation: boolean;
  readonly canPerform?: boolean; readonly canRecall?: boolean; readonly recallEvidence?: WorldJsonObject; readonly result?: WorldJsonObject }): ChatCall {
  const legacy = actionGroupWireSchema({ tools: { maximumExternalActions: 1,
    actionGroup: { allowedActionTypes: ['move', 'interact'] } }, messages: [
    { role: 'user', content: JSON.stringify({ segmentKind: 'affordances', content: request.context.affordances }) },
  ] })
  const actions = (legacy.properties as WorldJsonObject).actions as WorldJsonObject
  const items = actions.items as WorldJsonObject | undefined
  const variants = items === undefined ? [] : (items.oneOf as WorldJsonObject[] | undefined) ?? [items]
  const scene = request.context.scene as WorldJsonObject | undefined
  const actor = (request.context.character as WorldJsonObject | undefined)?.characterId
  const addressees = Array.isArray(scene?.people) ? scene.people
    .map(person => (person as WorldJsonObject).characterId)
    .filter((id): id is string => typeof id === 'string' && id !== actor) : []
  const canPerform = request.canPerform ?? !request.continuation
  const perform = canPerform ? variants.map(variant => {
    const properties = variant.properties as WorldJsonObject
    return { type: 'object', additionalProperties: false, required: ['decision', 'actionType', 'parameters'],
      properties: { decision: { const: 'perform' }, actionType: properties.actionType!, parameters: properties.parameters! } }
  }) : []
  return {
    schema: { type: 'object', oneOf: [
      { type: 'object', additionalProperties: false, required: ['decision'], properties: { decision: { const: 'abstain' } } },
      { type: 'object', additionalProperties: false, required: ['decision'], properties: {
        decision: { const: 'publish' },
        ...(addressees.length === 0 ? {} : { addresseeIds: { type: 'array', uniqueItems: true,
          maxItems: addressees.length, items: { type: 'string', enum: addressees } } }),
        speech: { type: 'string', maxLength: 2000 }, narration: { type: 'string', maxLength: 2000 } },
        anyOf: [{ required: ['speech'], properties: { speech: { minLength: 1 } } },
          { required: ['narration'], properties: { narration: { minLength: 1 } } }] },
      ...(request.canRecall === true ? [{ type: 'object', additionalProperties: false, required: ['decision', 'query'],
        properties: { decision: { const: 'recall' }, query: { type: 'string', minLength: 2, maxLength: 120 } } }] : []),
      ...perform,
    ] },
    description: '选择表达、主动查询自己的记忆、不补充内容，或在剩余预算内执行一次声明交互；执行提交后才会收到真实结果。',
    messages: [
      { role: 'system', content: '扮演场景中的这个角色，依据自己的性格和可见信息自主决定。'
        + '被唤醒只是处理新信息的机会，不要求你表演回应。没有要补充的内容时返回 abstain，不发布任何表达。'
        + '有意义的沉默、微笑、注视属于表达，可以 publish 自由 narration；对白用 speech。'
        + '物品 holderId 表示当前保管、携带和转交关系，不表示手是否碰到物品，也不表示所有权。null 表示尚未由个人保管、留在 locationId 所示场所。'
        + 'base:take 是纳入自己保管，base:give 是转交保管，base:drop 是解除个人保管并留在当前场所。这些迁移须 perform。'
        + '翻页、触碰、挪动、临时托起查看再放回可以自由表达；把自己保管的物品暂放桌上不自动解除保管。收进随身口袋带走则改变保管关系。'
        + '涉及已声明的重要交互或移动时选择 perform，不能用叙述代替执行，也不要提前描写成功后的情节。'
        + '观察中的 playerInput 是完整原始玩家输入，用来核对谁在说话、邀请谁做什么；抽取片段可能不完整。原文和邀请不证明行动成功，实际状态仍以裁定结果及可见物品为准。'
        + '若需要核对旧经历，可用 recall 以具体线索查询一次自己的记忆；结果只提供证据，不保证完整或真实，也不替你作结论。'
        + '记忆的 sourceAgeTicks 是其最新来源距当前的轮次差，不是现实时间；听到转述的轮次也不证明转述之事发生于那时，旧记录不自动代表现状。'
        + '他人说过的话只证明对方说过，不能因此断定所说之事发生。即使没找到记忆，也不能断定事情没发生。'
        + 'perform 的参数来自可尝试选项，结果由世界裁定。执行后会给你真实成功或失败结果与刷新后的场景。'
        + '一次激活最多尝试两次重要交互；仅在本次工具契约仍提供 perform 时才能再次请求。'
        + '没有 perform 时可以 publish 或 abstain；只有当前工具契约提供 recall 时才能查询记忆。表达不能改变受控状态或替别人决定反应。' },
      { role: 'user', content: JSON.stringify(request) },
    ],
  }
}
