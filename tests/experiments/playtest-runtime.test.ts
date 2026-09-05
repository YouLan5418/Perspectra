import { describe, expect, it } from 'vitest'
import { brandId, type CharacterView } from '@harness-world/contracts'
import { playerTranscript } from './playtest-runtime.ts'

describe('player-facing playtest transcript', () => {
  it('uses only the already authorized player observations', () => {
    const player = brandId('character:player', 'CharacterId')
    const address = { tenantId: brandId('tenant:test', 'TenantId'), worldId: brandId('world:test', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId') }
    const view: CharacterView = {
      address,
      characterId: player, asOfWorldSeq: 9, lifecycleState: 'active', locationId: 'location:room', scenes: [],
      observations: [
        { kind: 'observation', id: 'observation:1', sourceSeq: 4, value: { observerId: player,
          content: { status: 'accepted', speech: { characterId: 'character:bob', text: 'visible speech' } } } },
        { kind: 'observation', id: 'observation:2', sourceSeq: 5, value: { observerId: player,
          content: { status: 'rejected', speech: { characterId: 'character:bob', text: 'REJECTED_CANARY' } } } },
        { kind: 'observation', id: 'observation:3', sourceSeq: 6, value: { observerId: player,
          content: { status: 'accepted', contentVisibility: 'occurrence_only' } } },
        { kind: 'observation', id: 'observation:4', sourceSeq: 3, value: { observerId: player,
          content: { status: 'accepted', speech: { characterId: player, text: 'player speech' } } } },
        { kind: 'observation', id: 'observation:5', sourceSeq: 7, value: { observerId: player,
          content: { status: 'accepted', actorId: 'character:bob', actionType: 'move' } } },
        { kind: 'observation', id: 'observation:6', sourceSeq: 8, value: { observerId: player,
          content: { status: 'accepted', actorId: 'character:bob', actionType: 'take' } } },
      ],
      selfObservations: [],
      claims: [{ kind: 'claim', id: 'claim:private', sourceSeq: 2, value: { proposition: 'PRIVATE_CLAIM_CANARY' } }],
      goals: [], visibility: [], bundleHash: 'sha256:view',
    }
    const transcript = playerTranscript(view, new Map([
      [player, '玩家'], ['character:bob', 'Bob'],
    ]), player)
    expect(transcript).toEqual([
      { seq: 3, speaker: '玩家', text: 'player speech', player: true },
      { seq: 4, speaker: 'Bob', text: 'visible speech', player: false },
      { seq: 7, speaker: 'Bob', text: '移动到了另一个地点。', player: false },
      { seq: 8, speaker: 'Bob', text: '拿取了一个物品。', player: false },
    ])
    expect(JSON.stringify(transcript)).not.toMatch(/REJECTED_CANARY|PRIVATE_CLAIM_CANARY/)
  })

  it('falls back to the character id and ignores malformed observations', () => {
    const player = brandId('character:player', 'CharacterId')
    const address = { tenantId: brandId('tenant:test', 'TenantId'), worldId: brandId('world:test', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId') }
    const view = {
      address,
      characterId: player, asOfWorldSeq: 2, lifecycleState: 'active', locationId: null, scenes: [],
      observations: [
        { kind: 'observation', id: 'bad', sourceSeq: 1, value: null },
        { kind: 'observation', id: 'ok', sourceSeq: 2, value: { content: { status: 'accepted',
          speech: { characterId: 'character:unknown', text: 'hello' } } } },
      ], selfObservations: [], claims: [], goals: [], visibility: [], bundleHash: 'sha256:view',
    } as CharacterView
    expect(playerTranscript(view, new Map(), player)).toEqual([
      { seq: 2, speaker: 'character:unknown', text: 'hello', player: false },
    ])
  })
})
