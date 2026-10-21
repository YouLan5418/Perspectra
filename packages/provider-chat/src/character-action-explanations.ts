import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'

const object = (value: WorldJsonValue | undefined): WorldJsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as WorldJsonObject) : {}

/** Render only already-authorized options. No world lookup, extra target or inferred custom effect. */
export function characterActionExplanations(context: WorldJsonObject): WorldJsonObject[] {
  const scene = object(context.scene),
    current = typeof scene.name === 'string' ? scene.name : '当前位置'
  const people = Array.isArray(scene.people) ? scene.people.map(object) : []
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
          definition = object(option.definitionRef),
          args = object(option.arguments)
        if (typeof definition.id !== 'string' || typeof target.id !== 'string' || typeof option.bindingId !== 'string')
          continue
        const item = visible.find(row => row.entityId === target.id)
        const label = typeof item?.kind === 'string' ? item.kind : target.id
        const person = people.find(row => row.characterId === args.recipientId)
        const recipient = typeof person?.name === 'string' ? person.name : String(args.recipientId ?? '指定接收者')
        // These version-1 meanings are the existing base item definitions, not arbitrary ID inference.
        const basic = definition.version === 1 && target.kind === 'entity'
        const meaning =
          basic && definition.id === 'base:take'
            ? `取得保管：${label}`
            : basic && definition.id === 'base:give'
              ? `转交保管给${recipient}：${label}`
              : basic && definition.id === 'base:drop'
                ? `解除保管并留在${current}：${label}`
                : `请求交互 ${definition.id}（${target.id}）`
        const description =
          basic && definition.id === 'base:take'
            ? '请求将该物品实际纳入你保管；成功后，它由你携带和保管，不表示治疗、使用或取得所有权。'
            : basic && definition.id === 'base:give'
              ? `请求将该物品实际交由${recipient}保管；成功后保管人改变，不只是展示，也不表示对方接受了其他提议。`
              : basic && definition.id === 'base:drop'
                ? `请求解除你对该物品的个人保管，并将它留在${current}；成功后不再由你携带，不只是暂放桌上。`
                : '请求已有定义所声明的交互，具体效果以该定义与随后返回的裁定结果为准；如有参数契约，仍须填写其要求的内容。'
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
