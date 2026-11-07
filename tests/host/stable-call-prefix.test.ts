import { expect, it } from 'vitest'
import { characterTurnCall } from '@harness-world/provider-chat'
import { gatewayTurnCall } from '../../packages/official-llm/src/gateway-turn-call.ts'

const context = (extra: object = {}) => ({
  character: { characterId: 'character:claude' },
  scene: { people: [{ characterId: 'character:claude' }, { characterId: 'character:player' }] },
  affordances: [],
  history: [{ kind: 'observed', content: '屋主走进厨房。' }],
  ...extra,
})
// The steps of one activation and the next round differ only in these flags and in the dynamic context.
const variants = [
  { context: context(), continuation: false, canContinueAfterPublish: true },
  { context: context(), continuation: true, canContinueAfterPublish: false, afterPublication: true },
  { context: context({ recentExecutionEvidence: [{ action: 'move' }] }), continuation: false },
  { context: context({ expressionPolicy: { speech: 'free' } }), continuation: false },
  { context: context(), continuation: false, canPerform: true, canExpressBeforeAction: true },
]

it('keeps the opening contract identical across steps, so a provider can reuse the cached prefix', () => {
  for (const call of [characterTurnCall, gatewayTurnCall]) {
    const openings = new Set(variants.map(request => call(request).messages[0]!.content))
    expect(openings.size).toBe(1)
  }
})

it('offers the same gateway tool whoever is present, wherever she can go and whether this step can still perform', () => {
  const move = (ids: string[]) => ({ actionType: 'move', destinations: ids.map(locationId => ({ locationId })) })
  const tea = {
    actionType: 'interact',
    interactions: [
      {
        targetRef: { kind: 'entity', id: 'entity:tea' },
        bindingId: 'status',
        definitionRef: { id: 'status:drink-tea', version: 1 },
        argumentSchema: { type: 'object', properties: { amount: { type: 'integer', enum: [1] } } },
      },
    ],
  }
  const requests = [
    { context: context({ affordances: [move(['location:kitchen']), tea] }), continuation: false },
    {
      context: context({
        affordances: [move(['location:bathroom', 'location:hall'])],
        scene: { people: [{ characterId: 'character:claude' }] },
      }),
      continuation: false,
    },
    { context: context(), continuation: true, canPerform: false, afterPublication: true },
    { context: context({ affordances: [tea] }), continuation: true, canPerform: true },
  ]
  for (const canExpressBeforeAction of [false, true]) {
    const tools = new Set(
      requests.map(request => JSON.stringify(gatewayTurnCall({ ...request, canExpressBeforeAction }).schema)),
    )
    expect(tools.size).toBe(1)
  }
})

it('puts her goals and feelings after the history, since they can change while the history only grows', () => {
  const text = characterTurnCall({
    context: context({ cognition: { goals: [{ value: '切蛋糕' }] }, goals: [] }),
    continuation: false,
  }).messages.at(-1)!.content
  const keys = Object.keys(JSON.parse(text).context)
  expect(keys.indexOf('cognition')).toBeGreaterThan(keys.indexOf('history'))
  expect(keys.indexOf('goals')).toBeGreaterThan(keys.indexOf('history'))
})

it('tells a step that can no longer perform so at the end, since the tool still offers perform', () => {
  const last = characterTurnCall({ context: context(), continuation: true, canPerform: false }).messages.at(-1)!.content
  expect(JSON.parse(last).turnInstructions).toContain('本步不能 perform')
})

it('still states every step-specific rule, at the end of the request after the authorized context', () => {
  const rules: [object, string][] = [
    [variants[0]!, '本次首次 publish 后'],
    [variants[1]!, '你刚才已经正式发表了表达'],
    [variants[2]!, 'recentExecutionEvidence 是本次已经交付的授权执行证据'],
    [variants[3]!, '当前 activity 是临时玩法'],
    [variants[4]!, '本次 perform 可以附可选 before'],
    [{ context: context(), continuation: false }, 'publish 会结束本次处理机会'],
  ]
  for (const [request, rule] of rules) {
    const call = characterTurnCall(request as Parameters<typeof characterTurnCall>[0])
    const last = call.messages.at(-1)!.content
    expect(JSON.parse(last).context).toBeDefined()
    expect(last.indexOf(rule)).toBeGreaterThan(last.indexOf('屋主走进厨房'))
    expect(Object.keys(JSON.parse(last)).at(-1)).toBe('turnInstructions')
  }
})
