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

  it('renders reaction-round speech and action templates with causal chain validation', () => {
    const presenter = new DeterministicPresenter()
    const base = {
      observationType: 'reaction-round',
      cycleId: 'cycle-1',
      wave: 1,
      roundId: 'round-1',
      rootRoundId: 'root-round-1',
    }
    const speechObservation = {
      ...base,
      value: {
        observerId: 'character:player',
        actionId: 'action:alice:speak',
        content: {
          actorId: 'alice', actionType: 'speak', status: 'accepted',
          speech: { characterId: 'alice', text: '你好世界' },
        },
      },
    }
    expect(presenter.render(speechObservation)).toMatchObject({
      text: 'alice says: "你好世界"',
      reactionOrigin: { rootRoundId: 'root-round-1', cycleId: 'cycle-1', wave: 1, roundId: 'round-1' },
    })
    expect(presenter.render(speechObservation, { locale: 'zh-CN' }).text).toBe('角色 alice 说："你好世界"')

    const actionObservation = {
      ...base,
      value: { observerId: 'character:player', actionId: 'action:bob:move', content: { actorId: 'bob', actionType: 'move', status: 'accepted' } },
    }
    expect(presenter.render(actionObservation).text).toBe('bob acts: move')
    expect(presenter.render(actionObservation, { locale: 'zh-CN' }).text).toBe('角色 bob 行动：move')

    const rejected = { ...base, value: { observerId: 'character:player', actionId: 'action:rejected', content: { actorId: 'alice', actionType: 'speak', status: 'rejected', speech: { text: 'hi' } } } }
    expect(presenter.render(rejected).text).toContain('"status":"rejected"')

    const missingActorId = { ...base, value: { observerId: 'character:player', actionId: 'action:missing-actor', content: { actionType: 'speak', status: 'accepted' } } }
    expect(presenter.render(missingActorId).text).toBe('unknown acts: speak')

    const missingActionType = { ...base, value: { observerId: 'character:player', actionId: 'action:missing-type', content: { actorId: 'alice', status: 'accepted' } } }
    expect(presenter.render(missingActionType).text).toBe('alice acts: unknown')

    const unrecognizedStatus = { ...base, value: { observerId: 'character:player', actionId: 'action:pending', content: { actorId: 'alice', actionType: 'speak', status: 'pending' } } }
    expect(presenter.render(unrecognizedStatus).text).toContain('"status":"pending"')

    const missingWave = { observationType: 'reaction-round', cycleId: 'cycle-1', wave: 'not-a-number', roundId: 'round-1', rootRoundId: 'root-round-1', value: { value: { actorId: 'x', actionType: 'y', status: 'accepted' } } }
    expect(presenter.render(missingWave).text).toContain('"observationType":"reaction-round"')

    const missingValue = { ...base, value: null }
    expect(presenter.render(missingValue).text).toContain('"observationType":"reaction-round"')

    const innerMissingContent = { ...base, value: { observerId: 'character:player', actionId: 'action:no-content' } }
    expect(presenter.render(innerMissingContent).text).toContain('"actionId":"action:no-content"')
  })

  it('rejects unsupported render profiles and invalid World JSON', () => {
    const presenter = new DeterministicPresenter()
    expect(() => presenter.render({}, { locale: 'fr' as never })).toThrow('locale')
    expect(() => presenter.render({}, { style: 'rich' as never })).toThrow('style')
    expect(() => presenter.render(1.5)).toThrow('safe integers')
  })
})
