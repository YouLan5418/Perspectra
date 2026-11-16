import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ActivityHooks, ContentPackFacts, DiceRoll } from '@perspectra/sdk'
import { TRPG_ACTIVITY_PHASES } from './activity.ts'
import { officialTrpgContent } from './content.ts'
import { NativeActivity } from '@perspectra/providers/activities'
import { ActivityStateRules } from '@perspectra/core'

type ActivityState = Parameters<ActivityHooks['resolve']>[0]

const reference = (): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL('./fixtures/rainy-manor.trpg.json', import.meta.url), 'utf8'))

const pack: ContentPackFacts = {
  characterIds: ['character:player', 'character:aru', 'character:cheng', 'character:mei'],
  locationIds: ['location:living-room'],
  entityIds: [],
  entityLocations: {},
  playerId: 'character:player',
  names: { 'character:player': '玩家', 'character:aru': '阿茹', 'character:cheng': '澄', 'character:mei': '梅' },
}

function makeHooks(): ActivityHooks {
  const generated = officialTrpgContent.generate(reference(), pack)
  const entry = generated.activities?.[0]
  if (!entry) throw new Error('expected trpg activity')
  return entry.activity
}

function stateOf(participants: readonly string[], game: unknown): ActivityState {
  return {
    id: 'activity:trpg:1',
    key: 'trpg',
    locationId: 'location:living-room',
    participants: [...participants],
    startedRound: 1,
    revision: 1,
    game: game as ActivityState['game'],
  }
}

describe('official-trpg native activity hooks', () => {
  it('checks the actual restored phase and keeps the core escape phase available', () => {
    const activity = new NativeActivity({ key: 'trpg', activity: makeHooks() })
    const participants = ['character:player', 'character:aru']
    const game = activity.initialize(
      { npcIds: participants.slice(1), playerId: 'character:player', locationId: 'location:living-room' },
      () => 0.5,
    )
    const state = { id: 'activity:trpg:1', revision: 1, participants, game: game as ActivityState['game'] }
    const rules = new ActivityStateRules(activity.definition, 'character:player', 'trpg', activity.phases)
    const events = (phase: string, active = true) => [
      {
        eventType: 'activity.updated',
        eventVersion: 1,
        data: {
          activityKey: 'trpg',
          state: { ...state, game: { ...state.game, phase, active, turn: active ? 'character:player' : null } },
        },
      },
    ]
    expect(rules.state(events('setup'))?.game.phase).toBe('setup')
    expect(() => rules.state(events('phase-not-declared'))).toThrow('未声明的阶段')
    expect(rules.state(events('host-aborted', false))?.game.active).toBe(false)
  })
  it('declares persistent phases and initializes in setup on the player turn', () => {
    const hooks = makeHooks()
    expect(hooks.phases).toEqual(TRPG_ACTIVITY_PHASES)
    expect(hooks.phases).toEqual(['setup', 'invited', 'playing', 'ended'])
    const participants = ['character:player', 'character:aru', 'character:cheng']
    const initial = hooks.initialize(
      {
        locationId: 'location:living-room',
        participants,
        playerId: 'character:player',
      },
      () => 0.5,
    )
    expect(initial).toMatchObject({
      active: true,
      phase: 'setup',
      turn: 'character:player',
      round: 1,
    })
  })

  it('keeps hidden checks in GM private rolls and does not mutate input state', () => {
    const hooks = makeHooks()
    const npcIds = ['character:aru', 'character:cheng']
    const participants = ['character:player', ...npcIds]
    const started = hooks.initialize(
      {
        locationId: 'location:living-room',
        npcIds,
        playerId: 'character:player',
      },
      () => 0.5,
    )
    const invited = hooks.resolve(
      stateOf(participants, started),
      'character:player',
      'setup',
      { hostId: 'character:aru', scenario: 'rainy-manor' },
      {},
      null,
    )
    expect((invited.game as Record<string, unknown>).phase).toBe('invited')

    const snapshotBeforeAccept = structuredClone(invited.game)
    const accepted = hooks.resolve(
      stateOf(participants, invited.game),
      'character:aru',
      'respond',
      { accept: true },
      {},
      null,
    )
    expect(invited.game).toEqual(snapshotBeforeAccept)
    expect((accepted.game as Record<string, unknown>).phase).toBe('playing')
    const hostPrivate = ((accepted.game as Record<string, unknown>).private as Record<string, Record<string, unknown>>)[
      'character:aru'
    ]
    expect(JSON.stringify(hostPrivate?.hiddenContent ?? [])).toContain('账本')

    const fixedRoll = (expression: string): DiceRoll => ({
      expression,
      dice: [14],
      modifier: 0,
      total: 14,
    })
    const checked = hooks.resolve(
      stateOf(participants, accepted.game),
      'character:aru',
      'check',
      { targetId: 'character:cheng', skill: 'observe', difficulty: 12, hidden: true },
      {},
      null,
      fixedRoll,
    )
    const afterGame = checked.game as {
      private: Record<string, { rolls?: unknown[] }>
    }
    expect(checked.audience).toBe('self')
    expect(checked.privateNotes).toEqual({ 'character:aru': expect.stringContaining('暗骰·澄的观察检定') })
    expect(afterGame.private['character:aru']?.rolls).toHaveLength(1)
    expect(afterGame.private['character:cheng']?.rolls ?? []).toHaveLength(0)
    expect(afterGame.private['character:player']?.rolls ?? []).toHaveLength(0)
  })
})
