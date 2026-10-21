import { describe, expect, it } from 'vitest'
import type { StoredWorldEvent, WorldAddress } from '@harness-world/contracts'
import type { CreatorHistoryItem } from '../../../../desktop/host/creator-history.ts'
import type { CreatorRecord } from '../../../../desktop/host/creator-records.ts'
import { buildConversation, buildTrace, type RecordSummary } from './model.ts'
import type { NameTables } from './types.ts'

const address = { tenantId: 't', worldId: 'w', branchId: 'b' } as unknown as WorldAddress
const names: NameTables = {
  characters: { 'character:lin': '林澄', 'character:lu': '陆遥' },
  entities: { 'entity:key': '黄铜钥匙' },
  locations: { 'location:room': '前室' },
}

function event(
  seq: number,
  eventType: string,
  data: Record<string, unknown>,
  transactionId = 'tx-1',
): StoredWorldEvent {
  return {
    address,
    seq,
    tick: 10 + seq,
    eventType,
    eventVersion: 1,
    data,
    previousHash: 'sha256:x',
    eventHash: 'sha256:y',
    transactionId,
    eventOrdinal: 0,
  } as unknown as StoredWorldEvent
}
function history(item: Partial<CreatorHistoryItem> & { event: StoredWorldEvent }): CreatorHistoryItem {
  return {
    actorId: null,
    actionId: null,
    action: null,
    recipients: [],
    relatedSeqs: [],
    entityChange: null,
    ...item,
  } as unknown as CreatorHistoryItem
}
function summary(
  id: string,
  kind: RecordSummary['kind'],
  characterId: string,
  decisionId: string | null,
  capturedAt: string,
  status?: string,
): RecordSummary {
  return {
    id,
    kind,
    capturedAt,
    scope: { address, worldVersion: 'v', branchId: 'b', runId: 'r' },
    characterId,
    decisionId,
    summary: { label: kind, ...(status === undefined ? {} : { status }), durationMs: 12 },
  }
}
function detail(
  id: string,
  kind: CreatorRecord['kind'],
  characterId: string,
  decisionId: string | null,
  data: Record<string, unknown>,
): CreatorRecord {
  return {
    id,
    kind,
    capturedAt: '2026-01-01T00:00:00.000Z',
    scope: { address, worldVersion: 'v', branchId: 'b', runId: 'r' },
    characterId,
    decisionId,
    summary: { label: kind },
    data: data as CreatorRecord['data'],
  }
}

describe('轨迹合并', () => {
  const speak = history({
    event: event(3, 'character.speak', { characterId: 'character:lin', text: '拿好。' }),
    actorId: 'character:lin',
    actionId: 'action:1',
  })
  const resolved = history({
    event: event(2, 'action.resolved', { actionId: 'action:1', actorId: 'character:lin', accepted: true }),
    actorId: 'character:lin',
    actionId: 'action:1',
    action: { actionType: 'speak', parameters: { text: '拿好。' } },
  })
  const observation = history({
    event: event(4, 'observation.upsert', {
      id: 'o1',
      value: { observerId: 'character:lu', content: { text: '林澄说了句话。' } },
    }),
    actionId: 'action:1',
  })

  const records: RecordSummary[] = [
    summary('r-context', 'request', 'character:lin', 'decision-1', '2026-01-01T00:00:01.000Z', 'ok'),
    summary('r-action', 'action', 'character:lin', 'decision-1', '2026-01-01T00:00:02.000Z', 'accepted'),
    summary('r-turn', 'turn', 'character:lin', 'decision-1', '2026-01-01T00:00:03.000Z', 'responded'),
  ]
  const details: Record<string, CreatorRecord> = {
    'r-context': detail('r-context', 'request', 'character:lin', 'decision-1', {
      contextParts: [{ name: 'memories' }],
      response: { thinking: [], thinkingStatus: 'not_provided', content: [], toolCalls: [], finishReason: 'stop' },
    }),
    'r-action': detail('r-action', 'action', 'character:lin', 'decision-1', {
      actionId: 'action:1',
      action: { actionId: 'action:1', actionType: 'speak', parameters: { text: '拿好。' } },
      status: 'accepted',
      eventRefs: [2, 3, 4],
    }),
  }

  it('用行动记录取代同一次行动的 action.resolved 事件行', () => {
    const nodes = buildTrace({ history: [resolved, speak, observation], records, details, names })
    expect(nodes.filter(node => node.kind === 'action')).toHaveLength(1)
    expect(nodes.find(node => node.kind === 'action')?.recordId).toBe('r-action')
    expect(nodes.filter(node => node.seq === 2)).toHaveLength(0)
  })

  it('把私有记录按 eventRefs 落在对应已提交事件之前', () => {
    const nodes = buildTrace({ history: [resolved, speak, observation], records, details, names })
    const order = nodes.map(node => node.key)
    expect(order.indexOf('r-context')).toBeLessThan(order.indexOf('e3'))
    expect(order.indexOf('r-action')).toBeLessThan(order.indexOf('e3'))
    // 轮次在所属回合的已提交事件之后收尾
    expect(order.indexOf('r-turn')).toBeGreaterThan(order.indexOf('e4'))
  })

  it('未知正文的记录不把状态显示成未命中或失败', () => {
    const bare = [summary('r-recall', 'recall', 'character:lin', 'decision-1', '2026-01-01T00:00:04.000Z')]
    const nodes = buildTrace({ history: [], records: bare, details: {}, names })
    expect(nodes[0]?.statusLabel).toBe('已记录')
    expect(nodes[0]?.tone).toBe('muted')
  })

  it('没有行动记录的失败回合排在已提交事件之后', () => {
    const failed = [summary('r-fail', 'turn', 'character:lin', null, '2026-01-01T00:00:09.000Z', 'failed')]
    const nodes = buildTrace({ history: [resolved, speak, observation], records: failed, details: {}, names })
    const order = nodes.map(node => node.key)
    expect(order.indexOf('r-fail')).toBeGreaterThan(order.indexOf('e4'))
    expect(nodes.find(node => node.key === 'r-fail')?.tone).toBe('danger')
  })

  it('被拒绝的行动只留下行动行，模型调用收进处理过程', () => {
    const records = [
      summary('r-request-2', 'request', 'character:lin', 'decision-2', '2026-01-01T00:00:04.000Z', 'ok'),
      summary('r-action-2', 'action', 'character:lin', 'decision-2', '2026-01-01T00:00:05.000Z', 'rejected'),
    ]
    const nodes = buildTrace({ history: [], records, details: {}, names })
    expect(nodes.find(node => node.kind === 'action')?.processing).toBe(false)
    expect(nodes.find(node => node.kind === 'action')?.statusLabel).toBe('被拒绝')
    expect(nodes.find(node => node.kind === 'model')?.processing).toBe(true)
  })
})

describe('对话排版', () => {
  const events = [
    history({
      event: event(1, 'observation.upsert', {
        id: 'o1',
        value: { observerId: 'character:lu', content: { text: '听到了。' } },
      }),
    }),
    history({
      event: event(2, 'action.resolved', { actionId: 'action:1', actorId: 'character:lin', accepted: true }),
      actorId: 'character:lin',
      actionId: 'action:1',
      action: { actionType: 'speak', parameters: { text: '拿好。' } },
    }),
    history({
      event: event(3, 'character.speak', { characterId: 'character:lin', text: '拿好。' }),
      actorId: 'character:lin',
      actionId: 'action:1',
    }),
  ]
  const records = [
    summary('r-request', 'request', 'character:lin', 'decision-1', '2026-01-01T00:00:01.000Z', 'ok'),
    summary('r-action', 'action', 'character:lin', 'decision-1', '2026-01-01T00:00:02.000Z', 'accepted'),
  ]
  const details: Record<string, CreatorRecord> = {
    'r-request': detail('r-request', 'request', 'character:lin', 'decision-1', {
      contextParts: [{ name: 'memories' }],
    }),
    'r-action': detail('r-action', 'action', 'character:lin', 'decision-1', {
      actionId: 'action:1',
      action: { actionType: 'speak', parameters: {} },
      status: 'accepted',
      eventRefs: [2, 3],
    }),
  }

  it('模型调用归到它产出的那条回应上，而不是单独成条', () => {
    const nodes = buildTrace({ history: events, records, details, names })
    const entries = buildConversation(nodes.filter(node => !node.processing))
    const message = entries.find(entry => entry.kind === 'message')
    expect(message?.node?.key).toBe('e3')
    expect(message?.process.map(node => node.kind)).toContain('model')
    expect(entries.filter(entry => entry.kind === 'process')).toHaveLength(0)
  })

  it('同一段处理只归一次，中间穿插的已提交事件不打断归组', () => {
    const nodes = buildTrace({ history: events, records, details, names })
    const entries = buildConversation(nodes.filter(node => !node.processing))
    const kinds = entries.map(
      entry => `${entry.kind}:${entry.node?.kind ?? entry.process.map(node => node.kind).join('+')}`,
    )
    expect(kinds).toEqual(['row:observation', 'message:speak'])
  })

  it('NPC 的分段发言显示正文，不再显示为空表达', () => {
    const npc = history({
      event: event(5, 'character.speak', {
        characterId: 'character:lu',
        segments: [
          { type: 'narration', text: '放下筷子' },
          { type: 'speech', text: '我先说。' },
        ],
      }),
      actorId: 'character:lu',
      actionId: 'action:2',
    })
    const node = buildTrace({ history: [npc], records: [], details: {}, names })[0]
    expect(node?.summary).toBe('（放下筷子） 我先说。')
    expect(node?.segments?.map(segment => segment.type)).toEqual(['narration', 'speech'])
  })

  it('观察摘要取人读内容，同一行动的多条观察合并为一行', () => {
    const content = (observerId: string) => ({
      observerId,
      actionId: 'action:3',
      content: {
        actorId: 'character:lin',
        actionType: 'interact',
        status: 'accepted',
        resultDescription: '晚宴开始。',
      },
    })
    const nodes = buildTrace({
      history: [
        history({
          event: event(6, 'observation.upsert', { id: 'o6', value: content('character:lin') }),
          actionId: 'action:3',
        }),
        history({
          event: event(7, 'observation.upsert', { id: 'o7', value: content('character:lu') }),
          actionId: 'action:3',
        }),
      ],
      records: [],
      details: {},
      names,
    })
    expect(nodes[0]?.summary).toBe('林澄 互动：晚宴开始。')
    const entries = buildConversation(nodes)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.members?.map(node => node.characterId)).toEqual(['character:lin', 'character:lu'])
  })

  it('活动推进对应的通过行动不单列，没有行动参数时仍显示行动类型', () => {
    const resolved = history({
      event: event(10, 'action.resolved', {
        actionId: 'activity:1:action',
        actionType: 'interact',
        actorId: 'character:lin',
        accepted: true,
      }),
      actorId: 'character:lin',
      actionId: 'activity:1:action',
    })
    const activity = history({
      event: event(11, 'activity.updated', {
        actionId: 'activity:1:action',
        activityKey: 'dinner',
        operation: 'start',
        description: '晚宴开始。',
      }),
      actorId: 'character:lin',
      actionId: 'activity:1:action',
    })
    const nodes = buildTrace({ history: [activity, resolved], records: [], details: {}, names })
    expect(nodes.find(node => node.kind === 'action')?.summary).toBe('interact')
    expect(nodes.find(node => node.kind === 'activity')?.summary).toBe('活动 dinner · 开始')
    expect(buildConversation(nodes).map(entry => entry.node?.kind)).toEqual(['activity'])
  })

  it('发言对应的观察与通过行动不在阅读视图里重复', () => {
    const speech = history({
      event: event(8, 'character.speak', { characterId: 'character:lin', text: '好。' }),
      actorId: 'character:lin',
      actionId: 'action:4',
    })
    const seen = history({
      event: event(9, 'observation.upsert', {
        id: 'o9',
        value: {
          observerId: 'character:lu',
          actionId: 'action:4',
          content: { actorId: 'character:lin', actionType: 'speak', speech: { text: '好。' } },
        },
      }),
      actionId: 'action:4',
    })
    const entries = buildConversation(buildTrace({ history: [speech, seen], records: [], details: {}, names }))
    expect(entries.map(entry => entry.kind)).toEqual(['message'])
  })

  it('沉默回合的处理链单独成条，供「显示处理过程」展开', () => {
    const silent = [summary('r-turn', 'turn', 'character:lin', null, '2026-01-01T00:00:08.000Z', 'silent')]
    const nodes = buildTrace({ history: events, records: silent, details: {}, names })
    const entries = buildConversation(nodes)
    const process = entries.filter(entry => entry.kind === 'process')
    expect(process).toHaveLength(1)
    expect(process[0]?.process[0]?.kind).toBe('turn')
  })
})
