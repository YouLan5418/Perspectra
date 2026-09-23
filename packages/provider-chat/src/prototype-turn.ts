import type { WorldJsonObject } from '@harness-world/contracts'
import { actionGroupWireSchema, type ChatCall } from './wire.ts'

/** Reuse the existing definition-derived parameter schemas; only the decision shape changes. */
export function prototypeTurnCall(request: { readonly context: WorldJsonObject; readonly continuation: boolean;
  readonly canPerform?: boolean; readonly result?: WorldJsonObject }): ChatCall {
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
      ...perform,
    ] },
    description: '选择表达、不补充内容，或在剩余预算内执行一次声明交互；执行提交后才会收到真实结果。',
    messages: [
      { role: 'system', content: '扮演场景中的这个角色，依据自己的性格和可见信息自主决定。'
        + '被唤醒只是处理新信息的机会，不要求你表演回应。没有要补充的内容时返回 abstain，不发布任何表达。'
        + '有意义的沉默、微笑、注视属于表达，可以 publish 自由 narration；对白用 speech。'
        + '涉及已声明的重要交互或移动时选择 perform，不能用叙述代替执行，也不要提前描写成功后的情节。'
        + 'perform 的参数来自可尝试选项，结果由世界裁定。执行后会给你真实成功或失败结果与刷新后的场景。'
        + '一次激活最多尝试两次重要交互；仅在本次工具契约仍提供 perform 时才能再次请求。'
        + '没有 perform 时只能 publish 或 abstain。表达不能改变受控状态或替别人决定反应。' },
      { role: 'user', content: JSON.stringify(request) },
    ],
  }
}
