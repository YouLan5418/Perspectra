import { expect, it, vi } from 'vitest'
import { readPackComponents } from '../../apps/host/src/runtime/pack-components.ts'

it('accepts independent component regions and a sparse narrow override', () => {
  const components = {
    inventory: { anchor: 'index', order: 0, narrow: { anchor: 'toolbar' } },
    nearby: { label: '地上物品', anchor: 'story', order: 9 },
    sendAudience: { icon: 'arrow', anchor: 'footer-inset' },
    identity: { tone: 'forest', anchor: 'above-waist' },
    location: { anchor: 'toolbar', order: 1, narrow: { anchor: 'heading' } },
    history: { label: '回忆', anchor: 'story', order: 0 },
    activity: { label: '邀约', anchor: 'toolbar', icon: 'flag' },
    statusSummary: { anchor: 'heading', icon: 'meter', narrow: { order: 9 } },
  }
  const warn = vi.fn()
  expect(readPackComponents(Buffer.from(JSON.stringify({ version: 1, components })), warn)).toEqual(components)
  expect(warn).not.toHaveBeenCalled()
})

it('keeps valid siblings and diagnoses unknown fields, actions, HTML and URLs', () => {
  const warn = vi.fn()
  const bytes = Buffer.from(
    '{"version":1,"components":{"__proto__":{"bad":1},"inventory":{"label":"<img>","anchor":"story","order":90,"tone":"url(x)","narrow":{"action":"perform"}},"identity":{"anchor":"toolbar"},"sendAudience":{"shape":"soft","label":"点击赠送"}}}',
  )
  expect(readPackComponents(bytes, warn)).toEqual({ inventory: { anchor: 'story' } })
  expect(warn.mock.calls.map(c => c[0]).join(' ')).toContain('inventory.narrow.action')
})

it('keeps place names, status text and activity availability under official control', () => {
  const warn = vi.fn()
  const components = {
    location: { label: '未来地点', anchor: 'screen', order: -1 },
    history: { narrow: { label: '<img>', anchor: 'toolbar' } },
    statusSummary: { label: '已完成', hide: true, cut: false, anchor: 'story' },
    activity: { start: true, disabled: false, action: 'perform', anchor: 'toolbar' },
  }
  expect(readPackComponents(Buffer.from(JSON.stringify({ version: 1, components })), warn)).toEqual({
    history: { narrow: { anchor: 'toolbar' } },
    activity: { anchor: 'toolbar' },
  })
  expect(warn.mock.calls.flat().join(' ')).toContain('statusSummary.hide')
})

it.each(['{', 'null', '{"version":2,"components":{}}', '{"version":1,"components":[]}', ' '.repeat(8193)])(
  'falls back for an unreadable component file',
  raw => {
    const warn = vi.fn()
    expect(readPackComponents(Buffer.from(raw), warn)).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  },
)
