import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'

const object = (value: WorldJsonValue | undefined): WorldJsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as WorldJsonObject) : {}

/** Render only already-authorized options. No world lookup, extra target or inferred custom effect. */
export function characterActionExplanations(context: WorldJsonObject): WorldJsonObject[] {
  const scene = object(context.scene),
    current = typeof scene.name === 'string' ? scene.name : '当前位置'
  const items = object(context.items)
  const visible = Array.isArray(items.current) ? items.current.map(object) : []
  const options: WorldJsonObject[] = []
  for (const entry of Array.isArray(context.affordances) ? context.affordances : []) {
    const offer = object(entry)
    if (offer.actionType === 'move') {
      for (const value of Array.isArray(offer.destinations) ? offer.destinations : []) {
        const destination = object(value)
        if (typeof destination.locationId !== 'string') continue
        const name = typeof destination.name === 'string' ? destination.name : destination.locationId
        options.push({
          meaning: `前往${name}`,
          description: `你现在可以请求离开${current}，实际移动到${name}。成功后，你的位置会发生变化；不表示其他人与你同行。`,
          operation: { decision: 'perform', actionType: 'move', parameters: { locationId: destination.locationId } },
        })
      }
    } else if (offer.actionType === 'interact') {
      for (const value of Array.isArray(offer.interactions) ? offer.interactions : []) {
        const option = object(value),
          target = object(option.targetRef),
          definition = object(option.definitionRef)
        if (typeof definition.id !== 'string' || typeof target.id !== 'string' || typeof option.bindingId !== 'string')
          continue
        const item = visible.find(row => row.entityId === target.id)
        const label = typeof item?.kind === 'string' ? item.kind : target.id
        // The author's name for the action, with the item it is done to; an unnamed one shows its definition.
        const meaning =
          typeof option.label === 'string'
            ? option.label + (target.kind === 'entity' && !option.label.includes(label) ? `：${label}` : '')
            : `请求交互 ${definition.id}（${target.id}）`
        const description =
          '请求已有定义所声明的交互，具体效果以该定义与随后返回的裁定结果为准；如有参数契约，仍须填写其要求的内容。'
        options.push({
          meaning,
          description,
          operation: {
            decision: 'perform',
            actionType: 'interact',
            parameters: {
              targetRef: option.targetRef!,
              bindingId: option.bindingId,
              definitionRef: option.definitionRef!,
              arguments: option.arguments ?? {},
            },
          },
          ...(option.argumentSchema === undefined ? {} : { argumentSchema: option.argumentSchema }),
        })
      }
    }
  }
  return options
}

export const characterActionExplanationsNote =
  'context.actionExplanations 只是系统按当前 affordances 生成的操作语义说明，operation 对应已有 perform 请求；不是新增能力、固定行动要求或成功保证。需要行动时使用工具规定的字段与同一选项的参数，等待实际裁定结果。'
