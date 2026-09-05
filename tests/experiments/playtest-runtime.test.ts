import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brandId, type CharacterView } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { playerTranscript, WorldPlaytestRuntime } from './playtest-runtime.ts'

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

  it('commits host-grounded model actions and Reflection through the real application path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-playtest-actions-'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(init?.body as string) as { messages: { role: string; content: string }[] }
      const root = body.messages.some(message => message.content.includes('speak|move|take'))
      if (!root) {
        return new Response(JSON.stringify({ model: 'qwen3.5:4b', done_reason: 'stop',
          message: { content: '{"decision":"abstain","text":""}' } }), { status: 200 })
      }
      const anchor = body.messages.find(message => message.content.includes('"segmentKind":"character_anchor"'))?.content ?? ''
      if (!anchor.includes('character:alice')) {
        return new Response(JSON.stringify({ model: 'qwen3.5:4b', done_reason: 'stop',
          message: { content: '{"decision":"abstain","actions":[]}' } }), { status: 200 })
      }
      const selfMessage = body.messages.find(message => message.content.includes('"segmentKind":"current_self_state"'))!
      const self = JSON.parse(selfMessage.content) as { content: { consciousState: Array<{
        id: string
        kind: string
        value: { intensityPermille?: number }
      }> } }
      const relationship = self.content.consciousState.find(record => record.kind === 'relationship-attitude')!
      const response = {
        decision: 'act',
        actions: [
          { actionType: 'take', parameters: { entityId: 'entity:ticket-bundle' } },
          { actionType: 'move', parameters: { locationId: 'location:station-platform' } },
        ],
        reflection: [{ recordRef: relationship.id,
          changes: { intensityPermille: relationship.value.intensityPermille! + 100 } }],
      }
      return new Response(JSON.stringify({ model: 'qwen3.5:4b', done_reason: 'stop',
        message: { content: JSON.stringify(response) } }), { status: 200 })
    })
    let runtime: WorldPlaytestRuntime | undefined
    try {
      runtime = await WorldPlaytestRuntime.create({ dataDirectory: directory })
      const state = await runtime.submit('我们带上车票去车站。')
      const store = new WorldStore(join(directory, 'world.sqlite'))
      try {
        const events = store.readEvents({
          tenantId: brandId('tenant:web-playtest', 'TenantId'),
          worldId: brandId('world:rainy-road-web', 'WorldId'),
          branchId: brandId('branch:main', 'BranchId'),
        })
        const eventTypes = events.map(event => event.eventType)
        expect(eventTypes, JSON.stringify(events.filter(event => event.eventType === 'round.participant-terminal')))
          .toContain('entity.taken')
        expect(eventTypes).toContain('character.moved')
        expect(events.filter(event => event.eventType === 'character.reflect')).toHaveLength(1)
      } finally {
        store.close()
      }
      expect(state.transcript.map(entry => entry.text)).toEqual([
        '我们带上车票去车站。', '拿取了一个物品。', '移动到了另一个地点。',
      ])
      expect(fetchMock).toHaveBeenCalled()
    } finally {
      await runtime?.close()
      fetchMock.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
