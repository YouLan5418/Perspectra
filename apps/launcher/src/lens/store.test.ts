import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { LensSnapshot } from '../../../../desktop/lens/session.ts'

const bridge = vi.hoisted(() => ({ lensRequest: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))
vi.mock('../services/desktop.ts', () => ({ lensRequest: bridge.lensRequest }))
import { conditionItems } from '../../../../desktop/lens/ids.ts'
import { useLensStore } from './store.ts'

const source = { kind: 'json', file: 'characters.json', pointer: '/characters/0' } as const
const request = (id: string, state: 'open' | 'changed' | 'removed' | 'closed') => ({
  id,
  itemId: 'character:a',
  itemTitle: 'A',
  source,
  note: '改一下',
  valueAtCreation: [],
  createdAt: '2026-10-31T00:00:00.000Z',
  state,
})

function snapshot(): LensSnapshot {
  return {
    view: {
      packId: 'pack:test',
      packVersion: '1.0.0',
      title: '测试包',
      items: [
        { id: 'character:a', section: 'characters', title: 'A', fields: [], source },
        { id: 'character:b', section: 'characters', title: 'B', fields: [], source },
        {
          id: 'knowledge:character:a/goal',
          section: 'knowledge',
          title: '目标',
          parentId: 'character:a',
          fields: [],
          source,
        },
        { id: 'event:fridge', section: 'events', title: '冰箱', fields: [], source },
        { id: 'event:quiet', section: 'events', title: '安静', fields: [], source },
      ],
    },
    baseline: { kind: 'seen' },
    changes: [
      {
        kind: 'changed',
        id: 'knowledge:character:a/goal',
        fields: [{ key: 'content', label: '内容', before: '旧', after: '新' }],
      },
      { kind: 'added', id: 'character:b' },
      { kind: 'removed', id: 'event:fridge/when/时段是深夜', title: '时段是深夜', section: 'events' },
    ],
    requests: [request('1', 'open'), request('2', 'changed'), request('3', 'removed'), request('4', 'closed')],
    checkpoints: [],
    scenarios: [],
    simulation: {
      start: {},
      trace: [],
      conditions: [],
      npcOptions: {},
      state: {} as LensSnapshot['simulation']['state'],
    },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  bridge.lensRequest.mockReset()
  bridge.lensRequest.mockResolvedValue(snapshot())
})
const sent = () => bridge.lensRequest.mock.calls.map(([operation]) => operation as string)

it('indexes changes by item id', () => {
  const store = useLensStore()
  store.snapshot = snapshot()
  expect(store.changesById.get('character:b')).toEqual({ kind: 'added', id: 'character:b' })
  expect(store.changesById.get('knowledge:character:a/goal')?.kind).toBe('changed')
  expect(store.changesById.get('event:fridge/when/时段是深夜')?.kind).toBe('removed')
  expect(store.changesById.has('character:a')).toBe(false)
})

it('marks a parent whose child changed, including a removed child under its id', () => {
  const store = useLensStore()
  store.snapshot = snapshot()
  expect(store.hasChildChange('character:a')).toBe(true)
  expect(store.hasChildChange('event:fridge')).toBe(true)
  expect(store.hasChildChange('event:quiet')).toBe(false)
  expect(store.hasChildChange('character:b')).toBe(false)
})

it('counts only open and changed requests', () => {
  const store = useLensStore()
  expect(store.requestsOpenCount).toBe(0)
  store.snapshot = snapshot()
  expect(store.requestsOpenCount).toBe(2)
})

it('surfaces a failed operation in error and clears busy', async () => {
  const store = useLensStore()
  bridge.lensRequest.mockRejectedValueOnce(new Error('世界包读不了'))
  expect(await store.open('pack:test')).toBeUndefined()
  expect(store.error).toBe('世界包读不了')
  expect(store.busy).toBe(false)
  expect(store.snapshot).toBeNull()
  expect(await store.reload()).toBe(true)
  expect(store.error).toBe('')
})

it('sends the NPC plans before the step, and stops if the plans fail', async () => {
  const store = useLensStore()
  const plans = { 'character:a': [{ kind: 'abstain' as const }] }
  expect(await store.step({ kind: 'wait' }, plans)).toBe(true)
  expect(bridge.lensRequest.mock.calls).toEqual([
    ['lens-npc-plans', { plans }],
    ['lens-step', { step: { kind: 'wait' } }],
  ])
  bridge.lensRequest.mockClear()
  bridge.lensRequest.mockRejectedValueOnce(new Error('计划无效'))
  expect(await store.step({ kind: 'wait' }, plans)).toBe(false)
  expect(sent()).toEqual(['lens-npc-plans'])
  expect(store.error).toBe('计划无效')
})

it('only the seen action moves the baseline', async () => {
  const store = useLensStore()
  await store.open('pack:test')
  await store.reload()
  await store.setBaseline({ kind: 'checkpoint', name: '前' })
  await store.saveCheckpoint('前')
  await store.addRequest('character:a', '改')
  await store.close()
  expect(sent()).not.toContain('lens-seen')
  await store.open('pack:test')
  await store.markSeen()
  expect(sent().filter(operation => operation === 'lens-seen')).toHaveLength(1)
})

it('close clears local state, and a failed close is reported', async () => {
  const store = useLensStore()
  await store.open('pack:test')
  store.select('character:a')
  await store.close()
  expect(sent().at(-1)).toBe('lens-close')
  expect(store.snapshot).toBeNull()
  expect(store.selectedId).toBe('')
  expect(store.error).toBe('')

  await store.open('pack:test')
  bridge.lensRequest.mockRejectedValueOnce(new Error('后端没响应'))
  await store.close()
  expect(store.snapshot).toBeNull()
  expect(store.error).toBe('关闭透视失败：后端没响应')
  // Nothing open: closing again does not call the backend.
  bridge.lensRequest.mockClear()
  await store.close()
  expect(sent()).toEqual([])
})

it('condition ids follow one shared rule', () => {
  expect(conditionItems('event:x', [{ label: '深夜' }, { label: null }, { label: '深夜' }])).toEqual([
    { title: '深夜', id: 'event:x/when/深夜' },
    { title: '条件 2', id: 'event:x/when/条件 2' },
    { title: '深夜', id: 'event:x/when/深夜#2' },
  ])
})
