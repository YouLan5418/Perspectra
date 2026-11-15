import { describe, expect, it } from 'vitest'
import { exampleActorId, investigationGameplay, searchOperation } from './gameplay.example.ts'

describe('the self-described gameplay example', () => {
  it('keeps both heterogeneous operations on one definition', () => {
    expect(investigationGameplay.operations.map(operation => operation.id)).toEqual([
      'investigation:search',
      'investigation:inspect',
    ])
    expect(investigationGameplay.states?.map(state => state.key)).toEqual(['energy', 'clues'])
    expect(investigationGameplay.activities?.map(activity => activity.key)).toEqual(['investigation-site'])
  })

  it('initializes concrete state and formats an authorized operation result', () => {
    const initial = investigationGameplay.initializeState!({
      playerId: exampleActorId,
      characterIds: [exampleActorId],
      config: { cluePrefix: 'clue:', maxEnergy: 3 },
    })
    expect(initial).toEqual({ public: {}, characters: { [exampleActorId]: { energy: 3, clues: [] } } })
    const state = { energy: 3, clues: [] }

    const result = searchOperation.resolve({
      compute: () => {
        throw new Error('no registered method in this pure example')
      },
      actorId: exampleActorId,
      parameters: { locationId: 'location:archive', effort: 1 },
      state,
    })
    if (result.status !== 'accepted') throw new Error('expected accepted search')
    expect(
      searchOperation.npc?.formatResult({
        actorId: exampleActorId,
        recipientId: exampleActorId,
        outcome: result.outcome,
      }),
    ).toBe('发现线索 clue:archive-letter')
  })

  it('projects concrete player property and clue-list panels', () => {
    const view = investigationGameplay.playerView?.({
      playerId: exampleActorId,
      state: { energy: 2, clues: ['clue:archive-letter'] },
    })
    expect(view?.panels).toEqual([
      {
        kind: 'property-table',
        id: 'investigation:resources',
        title: '调查状态',
        properties: [
          { key: 'energy', label: '精力', value: 2 },
          { key: 'clueCount', label: '已获线索', value: 1 },
        ],
      },
      {
        kind: 'entry-list',
        id: 'investigation:clues',
        title: '线索',
        entries: [
          {
            id: 'clue:archive-letter',
            title: '已发现线索',
            content: 'clue:archive-letter',
          },
        ],
      },
    ])
  })
})
