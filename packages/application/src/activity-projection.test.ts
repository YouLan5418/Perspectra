import { expect, it } from 'vitest'
import type { ActivityPolicy, ActivityState, WorldJsonObject } from '@harness-world/contracts'
import type { ActionAffordance } from '@harness-world/kernel'
import {
  activityOperationOptions,
  checkActivityExpression,
  filterActivityAffordances,
  parseActivityOperationResult,
  parseActivityPlan,
  validateActivityDecision,
} from './activity-projection.ts'
import { ActivityStateRules } from './activity-state.ts'

const PLAYER = 'character:player',
  NPC = 'character:npc'
const closed = { type: 'object', additionalProperties: false, properties: {} }
const rules = new ActivityStateRules(
  {
    title: '猜数',
    npcIds: [NPC],
    operations: [
      { id: 'guess', label: '猜', requiresTurn: true, schema: closed },
      { id: 'quit', label: '退出', requiresTurn: false, schema: closed },
    ],
  },
  PLAYER,
  'guess',
)
const game = (overrides: WorldJsonObject = {}) => ({
  active: true,
  phase: 'play',
  turn: PLAYER,
  round: 1,
  public: {},
  private: { [PLAYER]: {}, [NPC]: {} },
  internal: {},
  ...overrides,
})
const state = (overrides: WorldJsonObject = {}) =>
  ({ id: 'activity:1', revision: 2, participants: [PLAYER, NPC], game: game(overrides) }) as unknown as ActivityState
const policy = (overrides: Partial<ActivityPolicy> = {}): ActivityPolicy =>
  ({
    speech: 'free',
    speechChoices: [],
    narration: true,
    move: true,
    interactions: ['status:take'],
    operations: ['guess', 'quit'],
    ...overrides,
  }) as ActivityPolicy

it('offers an operation only when allowed, and a turn operation only on that turn', () => {
  const ids = (actor: string) =>
    activityOperationOptions(state(), policy(), rules.operations, actor).map(
      o => (o.definitionRef as WorldJsonObject).id,
    )
  expect(ids(PLAYER)).toEqual(['activity:guess', 'activity:quit'])
  expect(ids(NPC)).toEqual(['activity:quit'])
  expect(activityOperationOptions(state(), policy({ operations: ['quit'] }), rules.operations, PLAYER)).toHaveLength(1)
})

it('binds an option to the exact activity and revision it was offered from', () => {
  const [option] = activityOperationOptions(state(), policy(), rules.operations, PLAYER)
  expect(option).toMatchObject({
    bindingId: 'activity:1',
    targetRef: { kind: 'character', id: PLAYER },
    arguments: { activityId: 'activity:1', revision: 2 },
  })
  expect(((option!.argumentSchema as WorldJsonObject).properties as WorldJsonObject).revision).toEqual({
    const: 2,
    type: 'integer',
  })
})

const base: ActionAffordance[] = [
  { actionType: 'speak', actionVersion: 1 },
  { actionType: 'move', actionVersion: 1 },
  {
    actionType: 'interact',
    actionVersion: 2,
    interactions: [
      { definitionRef: { id: 'status:take', version: 1 } },
      { definitionRef: { id: 'status:drop', version: 1 } },
    ],
  },
] as unknown as ActionAffordance[]
const interactions = (values: readonly ActionAffordance[]) =>
  values.find(a => a.actionType === 'interact')?.interactions?.map(i => (i.definitionRef as WorldJsonObject).id)

it('keeps one interact entry holding the allowed interactions and the activity options', () => {
  const options = [{ definitionRef: { id: 'activity:guess', version: 1 } }]
  const result = filterActivityAffordances(base, policy(), options, true)
  expect(result.filter(a => a.actionType === 'interact')).toHaveLength(1)
  expect(interactions(result)).toEqual(['status:take', 'activity:guess'])
})

it('removes what the policy forbids, and everything but speech when the actor cannot perform', () => {
  const noMove = filterActivityAffordances(base, policy({ move: false }), [], true)
  expect(noMove.map(a => a.actionType)).toEqual(['speak', 'interact'])
  const silent = filterActivityAffordances(base, policy({ speech: 'none', narration: false }), [], true)
  expect(silent.map(a => a.actionType)).toEqual(['move', 'interact'])
  const idle = filterActivityAffordances(base, policy(), [], false)
  expect(idle.map(a => a.actionType)).toEqual(['speak'])
})

it('refuses expression outside the policy', () => {
  expect(() => checkActivityExpression(policy({ narration: false }), { narration: '她笑了' })).toThrow('创作者许可')
  expect(() => checkActivityExpression(policy({ speech: 'none' }), { speech: '嗯' })).toThrow('创作者许可')
  expect(() => checkActivityExpression(policy({ speech: 'choices', speechChoices: ['是'] }), { speech: '否' })).toThrow(
    '创作者许可',
  )
  expect(() =>
    checkActivityExpression(policy({ speech: 'choices', speechChoices: ['是'] }), { speech: '是' }),
  ).not.toThrow()
})

it('refuses mixed decisions as a whole', () => {
  expect(() =>
    validateActivityDecision({ decision: 'publish', segments: [], actionType: 'move' }, policy(), 2000),
  ).toThrow('整包拒绝')
  expect(() =>
    validateActivityDecision({ decision: 'perform', actionType: 'move', parameters: {}, extra: 1 }, policy(), 2000),
  ).toThrow('整包拒绝')
  expect(() =>
    validateActivityDecision({ decision: 'perform', actionType: 'move', parameters: {} }, policy(), 2000),
  ).not.toThrow()
  expect(() => validateActivityDecision({ decision: 'abstain' }, policy(), 2000)).not.toThrow()
})

it('reads an author refusal as an answer and advances the revision of an accepted result', () => {
  expect(parseActivityOperationResult({ rejectReason: '不行' }, rules, state())).toEqual({ rejected: '不行' })
  expect(() => parseActivityOperationResult({ rejectReason: ' ' }, rules, state())).toThrow('拒绝说明')
  const accepted = parseActivityOperationResult(
    { game: game({ round: 2 }), description: '下一轮', audience: 'participants' },
    rules,
    state(),
  )
  expect(accepted).toMatchObject({ description: '下一轮', audience: 'participants', next: { revision: 3 } })
  expect(accepted).not.toHaveProperty('status')
})

it('refuses malformed results and games that break the participant shape', () => {
  const good = { game: game(), description: '好', audience: 'self' }
  expect(() => parseActivityOperationResult({ ...good, extra: 1 }, rules, state())).toThrow(TypeError)
  expect(() => parseActivityOperationResult({ ...good, audience: 'everyone' }, rules, state())).toThrow('游戏结果无效')
  expect(() =>
    parseActivityOperationResult({ ...good, game: game({ private: { [PLAYER]: {} } }) }, rules, state()),
  ).toThrow('私有变量')
  expect(() =>
    parseActivityOperationResult({ ...good, game: game({ turn: 'character:stranger' }) }, rules, state()),
  ).toThrow('阶段或轮次')
})

it('activates only a current participant who is not the player', () => {
  expect(parseActivityPlan({ kind: 'wait' }, state(), PLAYER)).toBeUndefined()
  expect(parseActivityPlan({ kind: 'activate', characterId: NPC }, state(), PLAYER)).toBe(NPC)
  for (const value of [
    { kind: 'activate', characterId: PLAYER },
    { kind: 'activate', characterId: 'character:stranger' },
    { kind: 'dance', characterId: NPC },
  ])
    expect(() => parseActivityPlan(value, state(), PLAYER)).toThrow('未授权')
  expect(() => parseActivityPlan({ kind: 'activate', characterId: NPC }, undefined, PLAYER)).toThrow('未授权')
  expect(() => parseActivityPlan({ kind: 'wait', characterId: NPC }, state(), PLAYER)).toThrow(TypeError)
})
