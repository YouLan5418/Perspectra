import { expect, it, vi } from 'vitest'
import type { StatusOperation, WorldJsonObject } from '@harness-world/contracts'
import {
  admitStatusOperation,
  parseStatusOffers,
  parseStatusOperationResult,
  statusObservationScope,
  statusOperationChoices,
} from './status-operations.ts'

const schema = { type: 'object', additionalProperties: false, properties: {} } as WorldJsonObject
const op = (id: string, extra: Partial<StatusOperation> = {}): StatusOperation => ({
  id,
  label: id,
  schema,
  characterParameters: [],
  actors: 'any',
  ...extra,
})
const operations = [
  op('wave'),
  op('take', { label: '拿起{item}', targets: ['entity:cup', 'entity:key'] }),
  op('secret', { actors: 'npc' }),
  op('dance', { activities: ['party'] }),
  op('give', { characterParameters: ['to'] }),
]

it('reads a null policy as every operation and refuses undeclared offers', () => {
  expect(parseStatusOffers(null, operations).operations).toEqual(operations.map(o => o.id))
  expect(() => parseStatusOffers({ operations: ['fly'] }, operations)).toThrow('未声明的操作')
  expect(() => parseStatusOffers({ operations: ['wave'], extra: 1 }, operations)).toThrow(TypeError)
  expect(() => parseStatusOffers({ operations: ['wave'], targets: { wave: [] } }, operations)).toThrow('作用于物品')
  expect(() => parseStatusOffers({ operations: ['take'], targets: { take: ['entity:box'] } }, operations)).toThrow(
    '没有声明的物品',
  )
  expect(parseStatusOffers({ operations: ['take'], targets: { take: ['entity:cup'] } }, operations).targets).toEqual({
    take: ['entity:cup'],
  })
})

function admit(overrides: Partial<Parameters<typeof admitStatusOperation>[0]> = {}) {
  return admitStatusOperation({
    operations,
    operationId: 'wave',
    targetId: undefined,
    parameters: {},
    actorId: 'character:player',
    playerId: 'character:player',
    activityKey: undefined,
    characterIds: ['character:player', 'character:npc', 'character:away'],
    validArguments: () => true,
    offers: () => ({ operations: operations.map(o => o.id) }),
    sceneIds: () => ['character:player', 'character:npc'],
    isReachable: () => true,
    ...overrides,
  })
}

it('admits a legal operation and reports each refusal without any status value', () => {
  expect(admit()).toMatchObject({ op: { id: 'wave' }, sceneIds: ['character:player', 'character:npc'] })
  const refusals: [Partial<Parameters<typeof admitStatusOperation>[0]>, string][] = [
    [{ operationId: 'fly' }, '没有这个状态操作'],
    [{ operationId: 'take' }, '不能对这件物品'],
    [{ operationId: 'wave', targetId: 'entity:cup' }, '不能对这件物品'],
    [{ operationId: 'take', targetId: 'entity:box' }, '不能对这件物品'],
    [{ operationId: 'dance' }, '指定活动'],
    [{ operationId: 'dance', activityKey: 'other' }, '指定活动'],
    [{ validArguments: () => false }, '必要信息'],
    [{ operationId: 'secret' }, '不能进行'],
    [{ offers: () => ({ operations: [] }) }, '已知条件'],
    [
      {
        operationId: 'take',
        targetId: 'entity:cup',
        offers: () => ({ operations: ['take'], targets: { take: ['entity:key'] } }),
      },
      '已知条件',
    ],
    [{ operationId: 'give', parameters: { to: 'character:nobody' } }, '角色不存在'],
    [{ operationId: 'give', parameters: { to: 'character:away' } }, '不在你当前的场景'],
    [{ operationId: 'take', targetId: 'entity:cup', isReachable: () => false }, '够得着'],
  ]
  for (const [input, reason] of refusals) expect(admit(input)).toEqual({ rejected: expect.stringContaining(reason) })
})

it('consults the policy and scene only once the cheaper checks pass, keeping the original order', () => {
  const offers = vi.fn(() => ({ operations: ['wave'] })),
    sceneIds = vi.fn(() => ['character:player'])
  admit({ validArguments: () => false, offers, sceneIds })
  expect(offers).not.toHaveBeenCalled()
  admit({ offers: () => ({ operations: [] }), sceneIds })
  expect(sceneIds).not.toHaveBeenCalled()
})

it('parses a result, an author refusal, and refuses malformed ones', () => {
  expect(parseStatusOperationResult({ rejectReason: '钱不够' })).toEqual({ rejected: '钱不够' })
  expect(() => parseStatusOperationResult({ rejectReason: '钱不够', changes: [] })).toThrow(TypeError)
  const good = { changes: [], reveals: [], description: '好', audience: 'self' }
  expect(parseStatusOperationResult(good)).toEqual(good)
  expect(parseStatusOperationResult({ ...good, items: [] })).toEqual({ ...good, items: [] })
  expect(() => parseStatusOperationResult({ ...good, extra: 1 })).toThrow(TypeError)
  expect(() => parseStatusOperationResult({ ...good, description: 'x'.repeat(2001) })).toThrow('描述无效')
  expect(() => parseStatusOperationResult({ ...good, changes: {} })).toThrow('必须是列表')
})

it('maps audiences to observation scopes inside the actor scene', () => {
  const scene = ['character:player', 'character:npc']
  expect(statusObservationScope('self', 'character:player', scene)).toEqual({
    scope: 'direct',
    recipientIds: ['character:player'],
  })
  expect(statusObservationScope('scene', 'character:player', scene)).toEqual({ scope: 'scene_public' })
  expect(statusObservationScope({ characters: ['character:npc'] }, 'character:player', scene)).toEqual({
    scope: 'direct',
    recipientIds: ['character:npc'],
  })
  // The actor always learns its own result, so telling nobody else is the same as telling only the actor.
  expect(statusObservationScope({ characters: [] }, 'character:player', scene)).toEqual({
    scope: 'direct',
    recipientIds: ['character:player'],
  })
  expect(() => statusObservationScope({ characters: ['character:away'] }, 'character:player', scene)).toThrow(
    '不在当前场景',
  )
})

it('offers only reachable, narrowed, in-scope operations with item labels', () => {
  const choices = statusOperationChoices({
    operations,
    offers: {
      operations: ['wave', 'take', 'secret', 'dance'],
      targets: { take: ['entity:cup', 'entity:key'] },
    },
    activityKey: undefined,
    actorId: 'character:player',
    playerId: 'character:player',
    isReachable: id => id === 'entity:cup',
    entityName: id => (id === 'entity:cup' ? '杯子' : id),
  })
  expect(choices.map(c => c.label)).toEqual(['wave', '拿起杯子'])
  expect(choices[1]).toMatchObject({
    targetRef: { kind: 'entity', id: 'entity:cup' },
    bindingId: 'status',
    definitionRef: { id: 'status:take', version: 1 },
  })
})
