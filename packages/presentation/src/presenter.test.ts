import { describe, expect, it } from 'vitest'
import { DeterministicPresenter } from './presenter.ts'

describe('DeterministicPresenter', () => {
  it('renders stable English and Chinese player action templates', () => {
    const presenter = new DeterministicPresenter()
    const accepted = { observationType: 'player-action-result', actionType: 'move', status: 'accepted', reason: null } as const
    const first = presenter.render(accepted)
    expect(first).toMatchObject({ locale: 'en', style: 'plain', text: 'Action completed: move', rendererProfileVersion: 1 })
    expect(presenter.render(accepted)).toEqual(first)
    expect(presenter.render({ ...accepted, status: 'rejected', reason: 'blocked' }, { locale: 'en' }).text)
      .toBe('Action rejected: move (blocked)')
    expect(presenter.render({ ...accepted, status: 'rejected' }, { locale: 'en', style: 'plain' }).text)
      .toBe('Action rejected: move')
    expect(presenter.render(accepted, { locale: 'zh-CN' }).text).toBe('行动已执行：move')
    expect(presenter.render({ ...accepted, status: 'rejected', reason: '受阻' }, { locale: 'zh-CN' }).text)
      .toBe('行动被拒绝：move（受阻）')
    expect(presenter.render({ ...accepted, status: 'rejected' }, { locale: 'zh-CN' }).text).toBe('行动被拒绝：move')
  })

  it('falls back to canonical JSON without interpreting unrecognized content', () => {
    const presenter = new DeterministicPresenter()
    expect(presenter.render({ z: 2, a: 1 }).text).toBe('{"a":1,"z":2}')
    expect(presenter.render(['visible']).text).toBe('["visible"]')
    expect(presenter.render(null).text).toBe('null')
    expect(presenter.render({ observationType: 'player-action-result', actionType: 1, status: 'accepted' }).text)
      .toContain('"actionType":1')
    expect(presenter.render({ observationType: 'player-action-result', actionType: 'move', status: 'unknown' }).text)
      .toContain('"status":"unknown"')
  })

  it('rejects unsupported render profiles and invalid World JSON', () => {
    const presenter = new DeterministicPresenter()
    expect(() => presenter.render({}, { locale: 'fr' as never })).toThrow('locale')
    expect(() => presenter.render({}, { style: 'rich' as never })).toThrow('style')
    expect(() => presenter.render(1.5)).toThrow('safe integers')
  })
})
