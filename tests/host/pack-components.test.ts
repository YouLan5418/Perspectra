import { expect, it, vi } from 'vitest'
import { readPackComponents } from '../../apps/host/src/runtime/pack-components.ts'

it('accepts independent component regions and a sparse narrow override', () => {
  const components = {
    inventory: { anchor: 'index', order: 0, narrow: { anchor: 'toolbar' } },
    nearby: { label: '地上物品', anchor: 'story', order: 9 },
    sendAudience: { icon: 'arrow', anchor: 'footer-inset' },
    identity: { tone: 'forest', anchor: 'above-waist' },
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

it.each(['{', 'null', '{"version":2,"components":{}}', '{"version":1,"components":[]}', ' '.repeat(8193)])(
  'falls back for an unreadable component file',
  raw => {
    const warn = vi.fn()
    expect(readPackComponents(Buffer.from(raw), warn)).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  },
)
