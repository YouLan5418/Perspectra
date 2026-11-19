import { expect, it } from 'vitest'
import type { PlayerView } from './player-view.ts'
import { createStatusPlayback } from './status-playback.ts'

function view(balance: number, seqs: number[] = []) {
  return {
    statusBar: [{ key: 'money', label: '余额', holderId: 'player', self: true, value: balance, current: true }],
    panels: [] as NonNullable<PlayerView['panels']>,
    history: seqs.map(seq => ({ seq, speaker: '旁白', text: '已发生 ' + seq, player: false })),
  }
}

it('has no snapshot on a fresh unread page, and freezes values until the full batch is revealed', () => {
  const playback = createStatusPlayback()
  const original = view(100, [1])
  const latest = {
    ...view(75, [1, 2, 3]),
    statusTruth: [{ key: 'unobserved', value: '隐藏状态' }],
  }
  expect(playback.update(latest, false)).toBeNull()
  expect(playback.update(original, true)?.statusBar[0]?.value).toBe(100)
  expect(playback.update(latest, false)?.statusBar[0]?.value).toBe(100)
  expect(playback.update(latest, true)?.statusBar[0]?.value).toBe(75)
  expect(playback.update(latest, true)).not.toHaveProperty('statusTruth')
})

it('withdraws authorization without adding new state or new authored panel rows before reading', () => {
  const playback = createStatusPlayback()
  const original = {
    ...view(100, [1]),
    panels: [
      {
        kind: 'property-table',
        id: 'ledger',
        title: '账本',
        properties: [
          { key: 'known', label: '记录', value: '已读值' },
          { key: 'revoked', label: '撤回的项目', value: '过时值' },
        ],
      },
      {
        kind: 'entry-list',
        id: 'notes',
        title: '笔记',
        entries: [{ id: 'visible', title: '已读条目', content: '旧描述' }],
      },
    ] satisfies PlayerView['panels'],
  }
  const replacement = {
    ...view(75, [1, 2]),
    statusBar: [],
    panels: [
      {
        kind: 'property-table',
        id: 'ledger',
        title: '新账本',
        properties: [
          { key: 'known', label: '记录', value: '之后的值' },
          { key: 'new', label: '新项目', value: '新内容' },
        ],
      },
      {
        kind: 'entry-list',
        id: 'notes',
        title: '笔记',
        entries: [
          { id: 'visible', title: '更新条目', content: '新描述' },
          { id: 'new', title: '新条目', content: '新内容' },
        ],
      },
    ] satisfies PlayerView['panels'],
  }
  playback.update(original, true)
  expect(playback.update(replacement, false)).toEqual({
    statusBar: [],
    panels: [
      {
        kind: 'property-table',
        id: 'ledger',
        title: '账本',
        properties: [{ key: 'known', label: '记录', value: '已读值' }],
      },
      original.panels[1],
    ],
  })
  expect(playback.update(original, false)?.statusBar).toEqual([])
  expect(playback.update(replacement, true)?.panels).toEqual(replacement.panels)
})

it('discards the snapshot on a rewritten transcript or an explicit branch change', () => {
  const original = view(100, [1, 2])
  const replacement = view(85, [1, 3])
  const playback = createStatusPlayback()
  playback.update(original, true)
  expect(playback.update(replacement, false)).toBeNull()
  playback.update(replacement, true)
  playback.invalidate()
  expect(playback.update(replacement, false)).toBeNull()
})
