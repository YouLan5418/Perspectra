import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { LensSnapshot } from '../../../../desktop/lens/session.ts'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))
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
    simulation: { start: {}, trace: [], conditions: [], state: {} as LensSnapshot['simulation']['state'] },
  }
}

beforeEach(() => setActivePinia(createPinia()))

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
