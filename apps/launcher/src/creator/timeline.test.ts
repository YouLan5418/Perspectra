import { describe, expect, it } from 'vitest'
import type { StoredWorldEvent, WorldAddress } from '@harness-world/contracts'
import type { CreatorHistoryItem } from '../../../../desktop/host/creator-history.ts'
import type { CreatorRecord } from '../../../../desktop/host/creator-records.ts'
import { buildTrace, type RecordSummary } from './model.ts'
import {
  buildClock,
  buildTimeline,
  causalChain,
  EMPTY_TIMELINE_FILTERS,
  filterNodes,
  locationBefore,
  SYSTEM_COLLAPSED,
  transitions,
} from './timeline.ts'
import type { NameTables, TraceNode } from './types.ts'

const address = { tenantId: 't', worldId: 'w', branchId: 'b' } as unknown as WorldAddress
const characters = [
  { id: 'character:gpt', name: 'GPT' },
  { id: 'character:claude', name: 'Claude' },
  { id: 'character:deepseek', name: 'DeepSeek' },
  { id: 'character:player', name: '玩家' },
]
const names: NameTables = {
  characters: Object.fromEntries(characters.map(character => [character.id, character.name])),
  entities: { 'entity:kitchen-pot': '料理锅与餐盘', 'entity:meal-platter': '餐盘' },
  locations: { 'location:kitchen': '厨房', 'location:aquarium': '城市水族馆', 'location:living-room': '客厅' },
}
const label = (id: string | null | undefined) => (id ? (names.characters[id] ?? id) : '')

function event(seq: number, tick: number, eventType: string, data: Record<string, unknown>, tx: string) {
  return {
    address,
    seq,
    tick,
    eventType,
    eventVersion: 1,
    data,
    previousHash: 'sha256:x',
    eventHash: 'sha256:y',
    transactionId: tx,
    eventOrdinal: 0,
  } as unknown as StoredWorldEvent
}
function item(stored: StoredWorldEvent, extra: Partial<CreatorHistoryItem> = {}): CreatorHistoryItem {
  const data = stored.data as Record<string, unknown>
  const value = (data.value ?? {}) as Record<string, unknown>
  return {
    event: stored,
    actorId: (data.actorId as string) ?? (data.characterId as string) ?? null,
    actionId: (data.actionId as string) ?? (value.actionId as string) ?? null,
    action: null,
    recipients: [],
    relatedSeqs: [],
    entityChange: null,
    ...extra,
  } as unknown as CreatorHistoryItem
}

/* 形状取自甜蜜日程存档 #1015–1022：GPT 做蛋炒饭的一次原子提交，后面接一条无关的 Claude 发言。 */
const COOK = 'character-turn:b32c:1:action'
const COOK_TX = 'character-turn:b32c:1:commit'
const observe = (seq: number, observer: string) =>
  item(
    event(
      seq,
      146,
      'observation.upsert',
      {
        id: `o${seq}`,
        value: {
          actionId: COOK,
          observerId: observer,
          content: { actionType: 'interact', actorId: 'character:gpt', resultDescription: '做出了黄金蛋炒饭。' },
        },
      },
      COOK_TX,
    ),
  )
const recipients = [
  { characterId: 'character:claude', visibility: 'full' as const, observationSeq: 1019 },
  { characterId: 'character:gpt', visibility: 'full' as const, observationSeq: 1020 },
  { characterId: 'character:player', visibility: 'full' as const, observationSeq: 1021 },
]
const history: CreatorHistoryItem[] = [
  item(
    event(
      990,
      140,
      'entity.upsert',
      { entityId: 'entity:kitchen-pot', kind: '待开火的料理锅', locationId: 'location:kitchen' },
      'tx-old',
    ),
  ),
  item(
    event(
      995,
      141,
      'character.moved',
      { characterId: 'character:deepseek', fromLocationId: 'location:kitchen', toLocationId: 'location:aquarium' },
      'tx-move',
    ),
  ),
  item(
    event(
      1015,
      146,
      'status.updated',
      {
        changes: [],
        description: '开火颠勺，做出了一大盘黄金蛋炒饭。',
        source: { actorId: 'character:gpt', kind: 'operation' },
      },
      COOK_TX,
    ),
  ),
  item(
    event(
      1016,
      146,
      'entity.upsert',
      { entityId: 'entity:kitchen-pot', kind: '热气腾腾的黄金蛋炒饭', locationId: 'location:kitchen' },
      COOK_TX,
    ),
  ),
  item(
    event(
      1017,
      146,
      'entity.upsert',
      { entityId: 'entity:meal-platter', kind: '盛着蛋炒饭的餐盘', locationId: 'location:kitchen' },
      COOK_TX,
    ),
  ),
  item(
    event(
      1018,
      146,
      'action.resolved',
      {
        accepted: true,
        actionId: COOK,
        actionType: 'interact',
        actorId: 'character:gpt',
        participantId: 'character-turn:b32c',
        sourceRole: 'agent',
      },
      COOK_TX,
    ),
    {
      recipients,
      action: { actionType: 'interact', parameters: { targetRef: { kind: 'entity', id: 'entity:kitchen-pot' } } },
    },
  ),
  observe(1019, 'character:claude'),
  observe(1020, 'character:gpt'),
  observe(1021, 'character:player'),
  item(event(1022, 146, 'world.tick-advanced', { tick: 146 }, COOK_TX)),
  item(
    event(
      1023,
      147,
      'character.speak',
      { characterId: 'character:claude', actionId: 'other:action', segments: [{ type: 'speech', text: '好香。' }] },
      'tx-next',
    ),
  ),
  item(
    event(
      1024,
      147,
      'action.resolved',
      {
        accepted: true,
        actionId: 'other:action',
        actionType: 'speak',
        actorId: 'character:claude',
        participantId: 'character-turn:zzz',
      },
      'tx-next',
    ),
  ),
]

function nodesOf(
  input: CreatorHistoryItem[],
  records: RecordSummary[] = [],
  details: Record<string, CreatorRecord> = {},
) {
  return buildTrace({ history: input, records, details, names, keepResolved: true })
}
const byKey = (nodes: TraceNode[], key: string) => nodes.find(node => node.key === key)!

describe('时间线排列', () => {
  const nodes = nodesOf(history)
  const model = buildTimeline(nodes, characters)

  it('按已提交序号稳定排序，每块一列，同一 tick 归为一组', () => {
    const seqs = model.items.map(entry => entry.node.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a! - b!))
    expect(new Set(model.items.map(entry => entry.column)).size).toBe(model.items.length)
    const cookGroup = model.ticks.find(group => group.tick === 146)!
    expect(model.items[cookGroup.from]!.node.seq).toBe(1015)
    expect(model.items[cookGroup.to]!.node.seq).toBe(1022)
  })

  it('角色泳道只放行为者的表达、移动和行动；状态与观察进系统泳道', () => {
    expect(model.index.get('e1018')!.lane).toBe('character:gpt')
    expect(model.index.get('e995')!.lane).toBe('character:deepseek')
    expect(model.index.get('e1015')!.lane).toBe('sys:world')
    expect(model.index.get('e1016')!.lane).toBe('sys:world')
    expect(model.index.get('e1019')!.lane).toBe('sys:observation')
  })

  it('同一行动的观察合并为一块，成员键都能定位', () => {
    const block = model.index.get('e1020')!
    expect(block).toBe(model.index.get('e1019'))
    expect(block.members.map(member => member.seq)).toEqual([1019, 1020, 1021])
    expect(model.items.filter(entry => entry.node.kind === 'observation')).toHaveLength(1)
  })

  it('已通过的裁定并入同一行动的发言块；被拒绝的裁定单独成块', () => {
    const speak = model.index.get('e1023')!
    expect(speak.members.map(member => member.key)).toEqual(['e1023', 'e1024'])
    expect(speak.status).toBe('ok')
    const rejected = nodesOf([
      item(
        event(1, 1, 'character.speak', { characterId: 'character:gpt', actionId: 'a', text: '我拿到了钥匙。' }, 't'),
      ),
      item(
        event(
          2,
          1,
          'action.resolved',
          { accepted: false, actionId: 'a', actorId: 'character:gpt', reason: '没有钥匙' },
          't',
        ),
      ),
    ])
    const split = buildTimeline(rejected, characters)
    expect(split.items).toHaveLength(2)
    expect(split.index.get('e2')!.status).toBe('rejected')
  })

  it('发言事件没写 actionId 时，仅在同一事务、同一行为者下并入裁定块', () => {
    // 真实存档里 character.speak 不带 actionId，history 由同事务的裁定推导出来。
    const speak = (tx: string) =>
      item(event(1, 1, 'character.speak', { characterId: 'character:gpt', text: '稍等。' }, tx), { actionId: 'r' })
    const resolved = item(
      event(2, 1, 'action.resolved', { accepted: true, actionId: 'r', actorId: 'character:gpt' }, 'same'),
    )
    expect(buildTimeline(nodesOf([speak('same'), resolved]), characters).items).toHaveLength(1)
    expect(buildTimeline(nodesOf([speak('other'), resolved]), characters).items).toHaveLength(2)
  })

  it('轮询与回填带来的重复条目只显示一次', () => {
    const doubled = buildTimeline([...nodes, ...nodes], characters)
    expect(doubled.items).toHaveLength(model.items.length)
  })

  it('不同角色的移动各自落在自己的泳道，不合并成共同移动', () => {
    const moves = nodesOf([
      item(
        event(1, 1, 'character.moved', { characterId: 'character:deepseek', toLocationId: 'location:aquarium' }, 'a'),
      ),
      item(event(2, 2, 'character.moved', { characterId: 'character:player', toLocationId: 'location:aquarium' }, 'b')),
    ])
    const lanes = buildTimeline(moves, characters).items.map(entry => entry.lane)
    expect(lanes).toEqual(['character:deepseek', 'character:player'])
  })

  it('玩家由裁定事件的 sourceRole 识别并排在最前；折叠时系统泳道合为一条', () => {
    const player = nodesOf([
      item(
        event(
          1,
          1,
          'action.resolved',
          { accepted: true, actionId: 'p', actorId: 'character:player', sourceRole: 'player' },
          'p',
        ),
      ),
    ])
    const collapsed = buildTimeline([...nodes, ...player], characters, { systemCollapsed: true })
    expect(collapsed.lanes[0]).toMatchObject({ id: 'character:player', player: true })
    expect(collapsed.lanes.filter(lane => lane.system).map(lane => lane.id)).toEqual([SYSTEM_COLLAPSED])
    expect(collapsed.index.get('e1016')!.lane).toBe(SYSTEM_COLLAPSED)
  })
})

describe('时间线筛选', () => {
  const nodes = nodesOf(history)
  const run = (patch: Partial<typeof EMPTY_TIMELINE_FILTERS>) =>
    filterNodes(nodes, { ...EMPTY_TIMELINE_FILTERS, ...patch }, characters, label).map(node => node.key)

  it('按角色、类型、结果与搜索筛选', () => {
    expect(run({ characterIds: ['character:deepseek'] })).toEqual(['e995'])
    expect(run({ kinds: ['movement'] })).toEqual(['e995'])
    expect(run({ statuses: ['ok'] })).toEqual(['e1018', 'e1024'])
    expect(run({ search: '蛋炒饭' })).toContain('e1015')
    expect(run({ search: '#1022' })).toEqual(['e1022'])
  })

  it('只看异常与隐藏系统事件', () => {
    expect(run({ abnormalOnly: true })).toEqual([])
    expect(run({ showSystem: false })).toEqual(['e995', 'e1018', 'e1023', 'e1024'])
  })
})

describe('确定关联', () => {
  const nodes = nodesOf(history)
  const cook = byKey(nodes, 'e1018')

  it('做饭裁定关联到观察、同一提交的物品与状态变化，不连接相邻的无关事件', () => {
    const chain = causalChain(cook, nodes, {}, characters)
    const related = new Map(chain.relations.map(relation => [relation.node.key, relation.kind]))
    expect(related.get('e1019')).toBe('action')
    expect(related.get('e1016')).toBe('commit')
    expect(related.get('e1015')).toBe('commit')
    expect(related.has('e1023')).toBe(false)
    expect(related.has('e1024')).toBe(false)
    expect(related.has('e990')).toBe(false)
    expect(chain.changes.map(relation => relation.node.key)).toEqual(
      expect.arrayContaining(['e1015', 'e1016', 'e1017']),
    )
    expect(chain.observations.map(relation => relation.node.key)).toEqual(['e1019', 'e1020', 'e1021'])
    expect(chain.sharedCommit).toBeNull()
  })

  it('区分实际收到观察的角色与没有观察记录的角色', () => {
    const chain = causalChain(cook, nodes, {}, characters)
    expect(chain.recipients.map(recipient => recipient.characterId)).toEqual([
      'character:claude',
      'character:gpt',
      'character:player',
    ])
    expect(chain.unobserved).toEqual(['character:deepseek'])
  })

  it('从状态变化反查时走同一提交，而不是凭时间相邻', () => {
    const chain = causalChain(byKey(nodes, 'e1016'), nodes, {}, characters)
    const keys = chain.relations.map(relation => relation.node.key)
    expect(keys).toContain('e1018')
    expect(keys).not.toContain('e995')
    expect(keys).not.toContain('e1023')
  })

  it('发言没写 actionId 时，经同一提交、同一行为者的裁定找到它的受众', () => {
    const speech = nodesOf([
      item(event(1, 1, 'character.speak', { characterId: 'character:gpt', text: '冰箱里只有鸡蛋。' }, 'tx'), {
        actionId: 'r',
      }),
      item(event(2, 1, 'action.resolved', { accepted: true, actionId: 'r', actorId: 'character:gpt' }, 'tx'), {
        recipients: [{ characterId: 'character:player', visibility: 'full', observationSeq: 3 }],
      }),
      item(event(3, 1, 'observation.upsert', { value: { actionId: 'r', observerId: 'character:player' } }, 'tx')),
    ])
    const chain = causalChain(byKey(speech, 'e1'), speech, {}, characters)
    expect(chain.relations.find(relation => relation.node.key === 'e3')?.kind).toBe('action')
    expect(chain.unobserved).toEqual(['character:gpt', 'character:claude', 'character:deepseek'])
  })

  it('没有 actionId 的事件不推定受众', () => {
    const chain = causalChain(byKey(nodes, 'e995'), nodes, {}, characters)
    expect(chain.unobserved).toBeNull()
    expect(chain.notes.join('')).toContain('不按同场景或时间推定')
  })

  it('一次提交含多个行动时明示状态变更不能归到某个行动', () => {
    const shared = nodesOf([
      item(event(1, 1, 'entity.upsert', { entityId: 'entity:meal-platter', kind: '空盘' }, 'round')),
      item(event(2, 1, 'action.resolved', { accepted: true, actionId: 'a', actorId: 'character:gpt' }, 'round')),
      item(event(3, 1, 'action.resolved', { accepted: true, actionId: 'b', actorId: 'character:player' }, 'round')),
    ])
    expect(causalChain(byKey(shared, 'e2'), shared, {}, characters).sharedCommit).toEqual({ actions: 2 })
  })

  it('同一处理周期的后续轮次按 participantId 关联', () => {
    const cycle = nodesOf([
      item(
        event(
          1,
          1,
          'action.resolved',
          { accepted: true, actionId: 'r0', actorId: 'character:gpt', participantId: 'turn:1' },
          't0',
        ),
      ),
      item(event(2, 2, 'character.speak', { characterId: 'character:gpt', actionId: 'r1', text: '我去做饭。' }, 't1')),
      item(
        event(
          3,
          2,
          'action.resolved',
          { accepted: true, actionId: 'r1', actorId: 'character:gpt', participantId: 'turn:1' },
          't1',
        ),
      ),
      item(
        event(
          4,
          3,
          'action.resolved',
          { accepted: true, actionId: 'x', actorId: 'character:gpt', participantId: 'turn:2' },
          't2',
        ),
      ),
    ])
    const chain = causalChain(byKey(cycle, 'e1'), cycle, {}, characters)
    expect(chain.followUps.map(relation => relation.node.key)).toEqual(['e2', 'e3'])
    expect(chain.relations.some(relation => relation.node.key === 'e4')).toBe(false)
    // 从后一轮看，较早轮次属于前因，不进“后续响应”；选中项本身列在裁定一步。
    const later = causalChain(byKey(cycle, 'e3'), cycle, {}, characters)
    expect(later.followUps).toEqual([])
    expect(later.origin.map(relation => relation.node.key)).toContain('e1')
    expect(later.verdict.map(relation => relation.node.key)).toContain('e3')
  })

  it('采集记录按 decisionId 与 eventRefs 连到已提交事件', () => {
    const records: RecordSummary[] = [
      summary('11111111-1111-1111-1111-111111111111', 'request', 'd1', '2026-10-01T10:00:00.000Z', 'ok', 1800),
      summary('22222222-2222-2222-2222-222222222222', 'action', 'd1', '2026-10-01T10:00:02.000Z', 'accepted', 40),
    ]
    const details = {
      '22222222-2222-2222-2222-222222222222': detail('22222222-2222-2222-2222-222222222222', 'action', 'd1', {
        actionId: COOK,
        eventRefs: [1015, 1016, 1017, 1018, 1019],
        startedAt: '2026-10-01T10:00:01.960Z',
      }),
    }
    const withRecords = nodesOf(history, records, details)
    const chain = causalChain(byKey(withRecords, records[0]!.id), withRecords, details, characters)
    const related = new Map(chain.relations.map(relation => [relation.node.key, relation.kind]))
    // 行动记录同时共享 decisionId 与 actionId，取更强的“同一行动”。
    expect(related.get(records[1]!.id)).toBe('action')
    expect(related.get('e1018')).toBe('action')
    expect(related.get('e1017')).toBe('eventRef')
    expect(related.has('e1023')).toBe(false)
  })
})

describe('实际耗时', () => {
  it('没有采集记录时不可用，并说明原因', () => {
    const clock = buildClock(nodesOf(history), {}, characters)
    expect(clock.available).toBe(false)
    expect(clock.reason).toContain('没有墙钟时间')
    expect(clock.omittedEvents).toBe(history.length)
  })

  it('只有记录了开始与耗时的调用画成条形，正文未读的行动记录只作瞬时标记', () => {
    const records = [
      summary('11111111-1111-1111-1111-111111111111', 'request', 'd1', '2026-10-01T10:00:00.000Z', 'ok', 1800),
      summary('22222222-2222-2222-2222-222222222222', 'action', 'd1', '2026-10-01T10:00:02.000Z', 'accepted', 40),
      summary('33333333-3333-3333-3333-333333333333', 'turn', 'd1', '2026-10-01T10:00:03.000Z', 'budget_exhausted'),
    ]
    const nodes = nodesOf([], records, {})
    const clock = buildClock(nodes, {}, characters)
    expect(clock.available).toBe(true)
    const byId = new Map(clock.items.map(entry => [entry.key, entry]))
    expect(clock.items).toHaveLength(3)
    const request = byId.get(records[0]!.id)!
    expect(request.end! - request.start).toBe(1800)
    expect(byId.get(records[1]!.id)!.end).toBeNull()
    expect(byId.get(records[2]!.id)!.end).toBeNull()
  })
})

describe('状态前后', () => {
  const nodes = nodesOf(history)
  const name = (id: string) => names.locations[id] ?? names.characters[id] ?? id

  it('前值取已载入的同一物品上一条记录', () => {
    const changes = transitions(byKey(nodes, 'e1016'), nodes, name)
    expect(changes.find(change => change.label === '描述')).toMatchObject({
      before: '待开火的料理锅',
      after: '热气腾腾的黄金蛋炒饭',
      beforeKnown: true,
    })
  })

  it('更早记录未载入时不推测前值', () => {
    const changes = transitions(byKey(nodes, 'e1017'), nodes, name)
    expect(changes.every(change => !change.beforeKnown && change.before === null)).toBe(true)
  })

  it('位置只从已载入的移动事件推导', () => {
    expect(locationBefore('character:deepseek', 1023, nodes)).toBe('location:aquarium')
    expect(locationBefore('character:gpt', 1023, nodes)).toBeNull()
  })
})

function summary(
  id: string,
  kind: RecordSummary['kind'],
  decisionId: string,
  capturedAt: string,
  status?: string,
  durationMs?: number,
): RecordSummary {
  return {
    id,
    kind,
    capturedAt,
    scope: { address, worldVersion: 'v', branchId: 'b', runId: 'r' },
    characterId: 'character:gpt',
    decisionId,
    summary: {
      label: kind,
      ...(status === undefined ? {} : { status }),
      ...(durationMs === undefined ? {} : { durationMs }),
    },
  }
}
function detail(
  id: string,
  kind: CreatorRecord['kind'],
  decisionId: string,
  data: Record<string, unknown>,
): CreatorRecord {
  return {
    id,
    kind,
    capturedAt: '2026-10-01T10:00:02.000Z',
    scope: { address, worldVersion: 'v', branchId: 'b', runId: 'r' },
    characterId: 'character:gpt',
    decisionId,
    summary: { label: kind },
    data: data as CreatorRecord['data'],
  }
}
