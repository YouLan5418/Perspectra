import { describe, expect, it } from 'vitest'
import { brandId, type CharacterView } from '@perspectra/sdk/contracts'
import { playerTranscript } from '../../apps/host/src/runtime/player-transcript.ts'

describe('player-facing playtest transcript', () => {
  it('uses only the already authorized player observations', () => {
    const player = brandId('character:player', 'CharacterId')
    const address = {
      tenantId: brandId('tenant:test', 'TenantId'),
      worldId: brandId('world:test', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const view: CharacterView = {
      address,
      characterId: player,
      asOfWorldSeq: 9,
      lifecycleState: 'active',
      locationId: 'location:room',
      scenes: [],
      observations: [
        {
          kind: 'observation',
          id: 'observation:1',
          sourceSeq: 4,
          value: {
            observerId: player,
            content: {
              status: 'accepted',
              speech: { characterId: 'character:bob', text: 'visible speech' },
              manifestation: {
                characterId: 'character:bob',
                description: null,
                cues: [
                  { cueId: 'cue:gaze', channel: 'gaze', description: '避开玩家的视线', persistence: 'event_only' },
                  { cueId: 'cue:voice', channel: 'voice', description: '声音压得很低', persistence: 'event_only' },
                ],
              },
            },
          },
        },
        {
          kind: 'observation',
          id: 'observation:2',
          sourceSeq: 5,
          value: {
            observerId: player,
            content: { status: 'rejected', speech: { characterId: 'character:bob', text: 'REJECTED_CANARY' } },
          },
        },
        {
          kind: 'observation',
          id: 'observation:3',
          sourceSeq: 6,
          value: { observerId: player, content: { status: 'accepted', contentVisibility: 'occurrence_only' } },
        },
        {
          kind: 'observation',
          id: 'observation:4',
          sourceSeq: 3,
          value: {
            observerId: player,
            content: { status: 'accepted', speech: { characterId: player, text: 'player speech' } },
          },
        },
        {
          kind: 'observation',
          id: 'observation:5',
          sourceSeq: 7,
          value: { observerId: player, content: { status: 'accepted', actorId: 'character:bob', actionType: 'move' } },
        },
        {
          kind: 'observation',
          id: 'observation:expression',
          sourceSeq: 9,
          value: {
            observerId: player,
            content: {
              status: 'accepted',
              speech: { characterId: 'character:bob', text: '', narration: '指尖蜷起，又慢慢松开。' },
            },
          },
        },
        {
          kind: 'observation',
          id: 'observation:6',
          sourceSeq: 8,
          value: { observerId: player, content: { status: 'accepted', actorId: 'character:bob', actionType: 'take' } },
        },
      ],
      selfObservations: [],
      claims: [{ kind: 'claim', id: 'claim:private', sourceSeq: 2, value: { proposition: 'PRIVATE_CLAIM_CANARY' } }],
      goals: [],
      visibility: [],
      bundleHash: 'sha256:view',
    }
    const transcript = playerTranscript(
      view,
      new Map([
        [player, '玩家'],
        ['character:bob', 'Bob'],
      ]),
      player,
    )
    expect(transcript).toEqual([
      { seq: 3, speaker: '玩家', speakerId: player, text: 'player speech', player: true },
      {
        seq: 4,
        speaker: 'Bob',
        speakerId: 'character:bob',
        text: '（避开玩家的视线，声音压得很低）\nvisible speech',
        player: false,
      },
      { seq: 7, speaker: 'Bob', speakerId: 'character:bob', text: '（Bob离开了。）', player: false },
      { seq: 8, speaker: 'Bob', speakerId: 'character:bob', text: '（Bob拿取了一个物品。）', player: false },
      { seq: 9, speaker: 'Bob', speakerId: 'character:bob', text: '（指尖蜷起，又慢慢松开。）', player: false },
    ])
    expect(JSON.stringify(transcript)).not.toMatch(/REJECTED_CANARY|PRIVATE_CLAIM_CANARY/)
  })

  it('falls back to the character id and ignores malformed observations', () => {
    const player = brandId('character:player', 'CharacterId')
    const address = {
      tenantId: brandId('tenant:test', 'TenantId'),
      worldId: brandId('world:test', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const view = {
      address,
      characterId: player,
      asOfWorldSeq: 2,
      lifecycleState: 'active',
      locationId: null,
      scenes: [],
      observations: [
        { kind: 'observation', id: 'bad', sourceSeq: 1, value: null },
        {
          kind: 'observation',
          id: 'ok',
          sourceSeq: 2,
          value: { content: { status: 'accepted', speech: { characterId: 'character:unknown', text: 'hello' } } },
        },
      ],
      selfObservations: [],
      claims: [],
      goals: [],
      visibility: [],
      bundleHash: 'sha256:view',
    } as CharacterView
    expect(playerTranscript(view, new Map(), player)).toEqual([
      { seq: 2, speaker: 'character:unknown', speakerId: 'character:unknown', text: 'hello', player: false },
    ])
  })

  it('shows author-declared Entity labels instead of runtime identities', () => {
    const player = brandId('character:player', 'CharacterId')
    const address = {
      tenantId: brandId('tenant:test', 'TenantId'),
      worldId: brandId('world:test', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const view = {
      address,
      characterId: player,
      asOfWorldSeq: 3,
      lifecycleState: 'active',
      locationId: 'location:room',
      scenes: [],
      observations: [
        {
          kind: 'observation',
          id: 'transfer',
          sourceSeq: 2,
          value: {
            observerId: player,
            content: {
              status: 'accepted',
              actorId: 'character:bob',
              actionType: 'interact',
              interaction: { entityId: 'entity:brass-key', toHolderId: 'character:bob' },
            },
          },
        },
        {
          kind: 'observation',
          id: 'move',
          sourceSeq: 3,
          value: {
            observerId: player,
            content: {
              status: 'accepted',
              actorId: 'character:bob',
              actionType: 'move',
              movement: { characterId: 'character:bob', toLocationId: 'location:back-room' },
            },
          },
        },
      ],
      selfObservations: [],
      claims: [],
      goals: [],
      visibility: [],
      bundleHash: 'sha256:view',
    } as CharacterView
    const transcript = playerTranscript(view, new Map([['character:bob', 'Bob']]), player, {
      entityNames: new Map([['entity:brass-key', '黄铜钥匙']]),
      locationNames: new Map([['location:back-room', '后室']]),
    })
    expect(transcript).toEqual([
      { seq: 2, speaker: 'Bob', speakerId: 'character:bob', text: '黄铜钥匙 已交由Bob保管。', player: false },
      { seq: 3, speaker: 'Bob', speakerId: 'character:bob', text: '（Bob去了后室。）', player: false },
    ])
    expect(JSON.stringify(transcript)).not.toContain('entity:brass-key')
  })

  it('recognizes a pickup only in the acting player’s complete, committed custody observation', () => {
    const player = brandId('character:player', 'CharacterId'),
      other = brandId('character:bob', 'CharacterId')
    const transfer = {
      characterId: player,
      entityId: 'entity:cup',
      fromHolderId: null,
      fromLocationId: 'location:room',
      toHolderId: player,
      toLocationId: null,
    }
    const content = { status: 'accepted', actorId: player, actionType: 'interact', interaction: transfer }
    const envelope = { observerId: player, actionId: 'action:committed', content }
    const observed = [
      envelope,
      { ...envelope, observerId: other },
      { ...envelope, content: { ...content, status: 'rejected' } },
      { ...envelope, content: { ...content, actionType: 'private_interaction', contentVisibility: 'occurrence_only' } },
      {
        ...envelope,
        content: { ...content, actorId: other, interaction: { ...transfer, characterId: other, fromHolderId: other } },
      },
      { ...envelope, content: { ...content, interaction: { entityId: 'entity:cup', toHolderId: player } } },
      { ...envelope, actionId: undefined },
      { ...envelope, content: { ...content, resultDescription: '茶杯 已交由玩家保管。', interaction: undefined } },
    ]
    const view = {
      characterId: player,
      observations: observed.map((value, i) => ({ value, sourceSeq: i + 1 })),
    } as unknown as CharacterView
    const results: number[] = []
    const lines = playerTranscript(
      view,
      new Map(),
      player,
      { entityNames: new Map([['entity:cup', '茶杯']]) },
      (_id, seq, pickup) => {
        if (pickup) results.push(seq)
      },
    )
    expect(results).toEqual([1])
    expect(JSON.stringify(lines)).not.toMatch(/entity:cup|toHolderId|action:committed/)
  })

  it('keeps the runtime identity when the author declared no Entity label', () => {
    const player = brandId('character:player', 'CharacterId')
    const address = {
      tenantId: brandId('tenant:test', 'TenantId'),
      worldId: brandId('world:test', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const view = {
      address,
      characterId: player,
      asOfWorldSeq: 2,
      lifecycleState: 'active',
      locationId: 'location:room',
      scenes: [],
      observations: [
        {
          kind: 'observation',
          id: 'transfer',
          sourceSeq: 2,
          value: {
            observerId: player,
            content: {
              status: 'accepted',
              actorId: 'character:bob',
              actionType: 'interact',
              interaction: { entityId: 'entity:unnamed', toHolderId: null },
            },
          },
        },
      ],
      selfObservations: [],
      claims: [],
      goals: [],
      visibility: [],
      bundleHash: 'sha256:view',
    } as CharacterView
    expect(
      playerTranscript(view, new Map([['character:bob', 'Bob']]), player, { entityNames: new Map() })[0]?.text,
    ).toBe('entity:unnamed 已解除个人保管，留在当前场所。')
  })
})
