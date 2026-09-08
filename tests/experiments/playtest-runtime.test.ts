import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brandId, type CharacterView } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import {
  canonicalCompiledWorldPackBytes,
  compileWorldPackSource,
  executeWorldPackCli,
} from '@harness-world/world-pack'
import { playerTranscript, WorldPlaytestRuntime } from './playtest-runtime.ts'

describe('player-facing playtest transcript', () => {
  it('loads an expressive creator Pack and renders only committed manifestation observations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-playtest-creator-pack-'))
    const sourceDirectory = join(directory, 'source')
    await executeWorldPackCli(['init', '--profile', 'expressive-social', sourceDirectory])
    const pack = await compileWorldPackSource(sourceDirectory)
    const packPath = join(directory, 'creator.worldpack.json')
    writeFileSync(packPath, canonicalCompiledWorldPackBytes(pack))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(init?.body as string) as { messages: { content: string }[] }
      const root = body.messages.some(message => message.content.includes('speak|move|take'))
      const alice = body.messages.some(message => message.content.includes('"segmentKind":"character_anchor"')
        && message.content.includes('character:alice'))
      return new Response(JSON.stringify({
        model: 'qwen3.5:4b', done_reason: 'stop',
        message: { content: JSON.stringify(root ? { decision: 'act', actions: [{
          actionType: 'speak', parameters: { text: alice ? 'Alice 已载入。' : 'Bob 已载入。' },
        }], manifestation: { description: alice ? 'Alice 抬起眼睛。' : 'Bob 点了点头。', cues: [{
          cueId: alice ? 'alice:gaze' : 'bob:gesture', channel: alice ? 'gaze' : 'gesture',
          description: alice ? '抬起眼睛' : '点了点头', persistence: 'event_only',
        }] } } : { decision: 'abstain', text: '' }) },
      }), { status: 200 })
    })
    let runtime: WorldPlaytestRuntime | undefined
    try {
      runtime = await WorldPlaytestRuntime.create({ dataDirectory: join(directory, 'data'), packPath })
      const initial = await runtime.state()
      expect(initial.world).toEqual({ title: '雨夜同行', playerName: '旅人', npcNames: ['Alice', 'Bob'] })
      const submitted = await runtime.submit('发生了什么')
      expect(Number(submitted.debug.providerCalls)).toBeGreaterThanOrEqual(2)
      expect(submitted.transcript).toContainEqual(expect.objectContaining({ player: true, text: '发生了什么' }))
      expect(submitted.transcript.map(entry => entry.text)).toEqual(expect.arrayContaining([
        '（Alice 抬起眼睛。）\nAlice 已载入。', '（Bob 点了点头。）\nBob 已载入。',
      ]))
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      await runtime?.close()
      fetchMock.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('uses only the already authorized player observations', () => {
    const player = brandId('character:player', 'CharacterId')
    const address = { tenantId: brandId('tenant:test', 'TenantId'), worldId: brandId('world:test', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId') }
    const view: CharacterView = {
      address,
      characterId: player, asOfWorldSeq: 9, lifecycleState: 'active', locationId: 'location:room', scenes: [],
      observations: [
        { kind: 'observation', id: 'observation:1', sourceSeq: 4, value: { observerId: player,
          content: { status: 'accepted', speech: { characterId: 'character:bob', text: 'visible speech' },
            manifestation: { characterId: 'character:bob', description: null, cues: [
              { cueId: 'cue:gaze', channel: 'gaze', description: '避开玩家的视线', persistence: 'event_only' },
              { cueId: 'cue:voice', channel: 'voice', description: '声音压得很低', persistence: 'event_only' },
            ] } } } },
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
      { seq: 4, speaker: 'Bob', text: '（避开玩家的视线，声音压得很低）\nvisible speech', player: false },
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
          { actionType: 'take', parameters: { entityRef: 'E1' } },
          { actionType: 'move', parameters: { locationRef: 'L1' } },
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

  it('uses the local utility model to translate natural-language player movement before role responses', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-playtest-player-intent-'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(init?.body as string) as { messages: { content: string }[] }
      const utility = body.messages.some(message => message.content.includes('玩家输入翻译器'))
      const content = utility
        ? { intent: 'move', targetRef: 'L1', question: '' }
        : body.messages.some(message => message.content.includes('speak|move|take'))
          ? { decision: 'abstain', actions: [] }
          : { decision: 'abstain', text: '' }
      return new Response(JSON.stringify({ model: 'qwen3.5:4b', done_reason: 'stop',
        message: { content: JSON.stringify(content) } }), { status: 200 })
    })
    let runtime: WorldPlaytestRuntime | undefined
    try {
      runtime = await WorldPlaytestRuntime.create({ dataDirectory: directory })
      const state = await runtime.submit('好，我们去车站吧。')
      const store = new WorldStore(join(directory, 'world.sqlite'))
      try {
        const moved = store.readEvents({
          tenantId: brandId('tenant:web-playtest', 'TenantId'), worldId: brandId('world:rainy-road-web', 'WorldId'),
          branchId: brandId('branch:main', 'BranchId'),
        }).filter(event => event.eventType === 'character.moved')
        expect(moved.map(event => event.data)).toContainEqual(expect.objectContaining({
          characterId: 'character:player',
          fromLocationId: 'location:road-shelter',
          toLocationId: 'location:station-platform',
        }))
      } finally {
        store.close()
      }
      expect(state.debug.lastPlayerIntent).toBe('move')
      expect(state.transcript).toContainEqual(expect.objectContaining({ player: true, text: '移动到了另一个地点。' }))
      const utilityBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
      expect(JSON.stringify(utilityBody.messages)).toContain('末班车站台')
      expect(JSON.stringify(utilityBody.messages)).not.toContain('location:station-platform')
    } finally {
      await runtime?.close()
      fetchMock.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves an input across clarification and bypasses the utility model for complete questions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-playtest-clarification-'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(init?.body as string) as { messages: { content: string }[] }
      const utility = body.messages.some(message => message.content.includes('玩家输入翻译器'))
      const root = body.messages.some(message => message.content.includes('speak|move|take'))
      const content = utility
        ? { intent: 'clarification', targetRef: '', question: '你是在说话，还是要执行一个动作？' }
        : root ? { decision: 'abstain', actions: [] } : { decision: 'abstain', text: '' }
      return new Response(JSON.stringify({ model: 'qwen3.5:4b', done_reason: 'stop',
        message: { content: JSON.stringify(content) } }), { status: 200 })
    })
    let runtime: WorldPlaytestRuntime | undefined
    try {
      runtime = await WorldPlaytestRuntime.create({ dataDirectory: directory })
      const pending = await runtime.submit('处理一下')
      expect(pending.transcript).not.toContainEqual(expect.objectContaining({ player: true }))
      expect(pending.debug.pendingClarification).toEqual({
        originalText: '处理一下', question: '你是在说话，还是要执行一个动作？',
      })

      const resolved = await runtime.submit('是speak')
      expect(resolved.transcript).toContainEqual(expect.objectContaining({ player: true, text: '处理一下' }))
      expect(resolved.transcript).not.toContainEqual(expect.objectContaining({ text: '是speak' }))
      expect(resolved.debug.pendingClarification).toBeNull()

      const question = await runtime.submit('发生了什么')
      expect(question.transcript).toContainEqual(expect.objectContaining({ player: true, text: '发生了什么' }))
      const utilityCalls = fetchMock.mock.calls.filter(([, init]) => {
        const body = JSON.parse(init?.body as string) as { messages: { content: string }[] }
        return body.messages.some(message => message.content.includes('玩家输入翻译器'))
      })
      expect(utilityCalls).toHaveLength(1)
    } finally {
      await runtime?.close()
      fetchMock.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps valid actions when an optional model Reflection is rejected', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-playtest-reflection-fallback-'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(init?.body as string) as { messages: { content: string }[] }
      const root = body.messages.some(message => message.content.includes('speak|move|take'))
      const alice = body.messages.some(message => message.content.includes('"segmentKind":"character_anchor"')
        && message.content.includes('character:alice'))
      const content = !root
        ? { decision: 'abstain', text: '' }
        : !alice
          ? { decision: 'abstain', actions: [] }
          : { decision: 'act', actions: [{ actionType: 'take', parameters: { entityRef: 'E1' } }],
              reflection: [{ recordRef: 'R999', changes: { confidencePermille: 500 } }] }
      return new Response(JSON.stringify({ model: 'qwen3.5:4b', done_reason: 'stop',
        message: { content: JSON.stringify(content) } }), { status: 200 })
    })
    let runtime: WorldPlaytestRuntime | undefined
    try {
      runtime = await WorldPlaytestRuntime.create({ dataDirectory: directory })
      const state = await runtime.submit('Alice，请带上车票。')
      expect(state.transcript.map(entry => entry.text)).toContain('拿取了一个物品。')
      const responseFiles = readdirSync(join(directory, 'requests')).filter(name => name.endsWith('.response.json'))
      const evidence = responseFiles.map(name => JSON.parse(readFileSync(join(directory, 'requests', name), 'utf8')))
      expect(evidence).toContainEqual(expect.objectContaining({ warning: 'reflection_rejected' }))
      const store = new WorldStore(join(directory, 'world.sqlite'))
      try {
        const events = store.readEvents({
          tenantId: brandId('tenant:web-playtest', 'TenantId'), worldId: brandId('world:rainy-road-web', 'WorldId'),
          branchId: brandId('branch:main', 'BranchId'),
        })
        expect(events.map(event => event.eventType)).toContain('entity.taken')
        expect(events.map(event => event.eventType)).not.toContain('character.reflect')
      } finally {
        store.close()
      }
    } finally {
      await runtime?.close()
      fetchMock.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('classifies malformed model output as retryable quality evidence instead of a Provider outage', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-playtest-invalid-output-'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(init?.body as string) as { messages: { content: string }[] }
      const root = body.messages.some(message => message.content.includes('speak|move|take'))
      const alice = body.messages.some(message => message.content.includes('"segmentKind":"character_anchor"')
        && message.content.includes('character:alice'))
      const content = root && alice
        ? { decision: 'act', actions: [{ actionType: 'invented', parameters: {} }] }
        : root ? { decision: 'abstain', actions: [] } : { decision: 'abstain', text: '' }
      return new Response(JSON.stringify({ model: 'qwen3.5:4b', done_reason: 'stop',
        message: { content: JSON.stringify(content) } }), { status: 200 })
    })
    let runtime: WorldPlaytestRuntime | undefined
    try {
      runtime = await WorldPlaytestRuntime.create({ dataDirectory: directory })
      const state = await runtime.submit('请回应。')
      expect(state.notice).toContain('无效动作格式')
      const store = new WorldStore(join(directory, 'world.sqlite'))
      try {
        const terminals = store.readEvents({
          tenantId: brandId('tenant:web-playtest', 'TenantId'), worldId: brandId('world:rainy-road-web', 'WorldId'),
          branchId: brandId('branch:main', 'BranchId'),
        }).filter(event => event.eventType === 'round.participant-terminal'
          && (event.data as { participantId?: string }).participantId === 'agent:alice')
        expect(terminals.map(event => (event.data as { status: string }).status)).toContain('schema_invalid')
        expect(terminals.map(event => (event.data as { status: string }).status)).not.toContain('provider_failed')
      } finally {
        store.close()
      }
      expect(readdirSync(join(directory, 'requests')).some(name => name.endsWith('.invalid.json'))).toBe(true)
    } finally {
      await runtime?.close()
      fetchMock.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
