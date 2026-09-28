import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { currentCharacterRelations, currentEntityState, currentLocation } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { FrozenWorldPlaytestRuntime } from '../experiments/playtest-frozen-runtime.ts'

const keyAction = { decision: 'perform', actionType: 'interact', parameters: {
  targetRef: { kind: 'entity', id: 'entity:brass-key' }, bindingId: 'binding:key-take',
  definitionRef: { id: 'base:take', version: 1 }, arguments: {},
} }

it('closes the frozen G1 combination: hand contact, shared key, two NPCs and two rooms', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prototype-g1-combination-'))
  let stage = 'hold'
  const used = new Set<string>()
  const calls: { stage: string; actor: string; continuation: boolean;
    stimulus: readonly { content: { actionType?: string; actorId?: string; movement?: Record<string, unknown> } }[];
    memories: readonly { text: string; sourceMaxSeq: number }[]; observationSeqs: readonly number[];
    selfObservationSeqs: readonly number[] }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const wire = JSON.parse(body)
      const input = JSON.parse(wire.messages.at(-1).content)
      const actor = String(input.context.character.characterId)
      calls.push({ stage, actor, continuation: input.continuation, stimulus: input.context.stimulus,
        memories: input.context.memories,
        observationSeqs: input.context.observations.map((record: { sourceSeq: number }) => record.sourceSeq),
        selfObservationSeqs: input.context.selfObservations.map((record: { sourceSeq: number }) => record.sourceSeq) })
      let answer: unknown = { decision: 'abstain' }
      if (stage === 'take' && actor === 'character:companion') {
        if (input.continuation) {
          expect(input.result.status).toBe('accepted')
          answer = { decision: 'publish', speech: '钥匙拿到了。' }
        } else if (!used.has('take')) { used.add('take'); answer = keyAction }
      }
      if (stage === 'stale' && actor === 'character:friend') {
        if (input.continuation) {
          expect(input.result.status).toBe('rejected')
          answer = { decision: 'publish', speech: '它现在不在桌上，我没有拿到。' }
        } else if (!used.has('stale')) { used.add('stale'); answer = keyAction }
      }
      if (stage === 'move' && actor === 'character:companion') {
        if (input.continuation) {
          expect(input.result.status).toBe('accepted')
          expect(input.context.scene.locationId).toBe('location:back-room')
          answer = { decision: 'publish', speech: '我进后室了。' }
        } else if (!used.has('move')) {
          used.add('move')
          answer = { decision: 'perform', actionType: 'move', parameters: { locationId: 'location:back-room' } }
        }
      }
      if (stage === 'back-talk' && actor === 'character:companion' && !used.has('back-talk')) {
        used.add('back-talk')
        answer = { decision: 'publish', speech: '这里只有我们俩。' }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
    })
  })
  let runtime: FrozenWorldPlaytestRuntime | undefined
  try {
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', () => ready()))
    const port = (server.address() as { port: number }).port
    runtime = await FrozenWorldPlaytestRuntime.create({ dataDirectory: root,
      packPath: resolve('examples/world-packs/prototype-g1'), provider: 'ollama', model: 'fixture',
      utilityEndpoint: `http://127.0.0.1:${port}/api/chat` })
    const submit = async (next: string, text: string) => {
      stage = next
      const state = await runtime!.submit(text)
      expect(state.error, `${next}: ${state.notice}`).toBe(false)
      return state
    }
    const events = () => {
      const store = new WorldStore(resolve(root, 'world.sqlite'))
      try { return store.readEvents(runtime!.address) } finally { store.close() }
    }
    const moveViews = (actor: string, destination: string) => {
      const all = events()
      const move = all.findLast(event => event.eventType === 'character.moved'
        && (event.data as Record<string, unknown>).characterId === actor
        && (event.data as Record<string, unknown>).toLocationId === destination)!
      return new Map(all.filter(event => event.eventType === 'observation.upsert' && event.transactionId === move.transactionId
        && (event.data as { value: { content: { actorId?: string } } }).value.content.actorId === actor)
        .map(event => {
          const { observerId, content } = (event.data as { value: { observerId: string; content: { movement?: unknown } } }).value
          return [observerId, content.movement] as const
        }))
    }
    expect((await runtime.state()).world.currentScene).toEqual({ locationName: '前室',
      presentNpcNames: ['同行者', '留守者'] })

    await submit('hold', '/act interact {"targetRef":{"kind":"character","id":"character:companion"},"bindingId":"binding:companion-hold","definitionRef":{"id":"base:hold-hand","version":1},"arguments":{}}')
    expect(currentCharacterRelations(events()).filter(relation => relation.active)).toHaveLength(1)

    await submit('take', '/act speak {"text":"同行者，请拿起黄铜钥匙。"}')
    expect(currentEntityState(events(), 'entity:brass-key')?.holderId).toBe('character:companion')
    expect(events().filter(event => event.eventType === 'entity.transferred')).toHaveLength(1)

    await submit('stale', '/act speak {"text":"留守者，你也试着拿同一把钥匙。"}')
    expect(events().filter(event => event.eventType === 'entity.transferred')).toHaveLength(1)
    expect(calls.every(call => call.memories.every(memory =>
      !call.observationSeqs.includes(memory.sourceMaxSeq)
      && !call.selfObservationSeqs.includes(memory.sourceMaxSeq)))).toBe(true)
    expect(events().some(event => event.eventType === 'action.resolved'
      && (event.data as Record<string, unknown>).actorId === 'character:friend'
      && (event.data as Record<string, unknown>).accepted === false)).toBe(true)

    const movedState = await submit('move', '/act move {"locationId":"location:back-room"}')
    expect(currentLocation(events(), 'character:player')).toBe('location:back-room')
    expect(currentLocation(events(), 'character:companion')).toBe('location:back-room')
    expect(currentLocation(events(), 'character:friend')).toBe('location:front-room')
    expect(movedState.world.currentScene).toEqual({ locationName: '后室', presentNpcNames: ['同行者'] })
    const outwardViews = moveViews('character:player', 'location:back-room')
    expect(outwardViews.get('character:player')).toEqual({ characterId: 'character:player',
      fromLocationId: 'location:front-room', toLocationId: 'location:back-room' })
    expect(outwardViews.get('character:friend')).toEqual({ characterId: 'character:player',
      fromLocationId: 'location:front-room' })
    expect(outwardViews.get('character:companion')).toEqual({ characterId: 'character:player',
      fromLocationId: 'location:front-room' })
    const companionViews = moveViews('character:companion', 'location:back-room')
    expect(companionViews.get('character:companion')).toEqual({ characterId: 'character:companion',
      fromLocationId: 'location:front-room', toLocationId: 'location:back-room' })
    expect(companionViews.get('character:friend')).toEqual({ characterId: 'character:companion',
      fromLocationId: 'location:front-room' })
    expect(companionViews.get('character:player')).toEqual({ characterId: 'character:companion',
      toLocationId: 'location:back-room' })
    const friendSeesCompanionLeave = calls.filter(call => call.stage === 'move'
      && call.actor === 'character:friend').flatMap(call => call.stimulus)
      .find(value => value.content.actionType === 'move'
        && value.content.actorId === 'character:companion')?.content.movement
    expect(friendSeesCompanionLeave).toEqual({ characterId: 'character:companion',
      fromLocationId: 'location:front-room' })

    await submit('back-talk', '/act speak {"text":"后室里现在是谁？"}')
    const backSpeech = events().findLast(event => event.eventType === 'character.speak'
      && (event.data as Record<string, unknown>).text === '这里只有我们俩。')!
    const receivers = events().filter(event => event.eventType === 'observation.upsert'
      && event.transactionId === backSpeech.transactionId
      && ((event.data as { value: { content?: { speech?: { text?: string } } } }).value.content?.speech?.text === '这里只有我们俩。'))
      .map(event => (event.data as { value: { observerId: string } }).value.observerId)
    expect(receivers).toContain('character:player')
    expect(receivers).not.toContain('character:friend')
    expect(calls.filter(call => call.stage === 'back-talk' && call.actor === 'character:friend')).toHaveLength(0)

    const returnedState = await submit('return', '/act move {"locationId":"location:front-room"}')
    expect(currentLocation(events(), 'character:player')).toBe('location:front-room')
    expect(currentLocation(events(), 'character:companion')).toBe('location:back-room')
    expect(currentEntityState(events(), 'entity:brass-key')?.holderId).toBe('character:companion')
    expect(returnedState.world.currentScene).toEqual({ locationName: '前室', presentNpcNames: ['留守者'] })
    const returnViews = moveViews('character:player', 'location:front-room')
    expect(returnViews.get('character:player')).toEqual({ characterId: 'character:player',
      fromLocationId: 'location:back-room', toLocationId: 'location:front-room' })
    expect(returnViews.get('character:companion')).toEqual({ characterId: 'character:player',
      fromLocationId: 'location:back-room' })
    expect(returnViews.get('character:friend')).toEqual({ characterId: 'character:player',
      toLocationId: 'location:front-room' })
    const returnStimulus = (actor: string) => calls.find(call => call.stage === 'return' && call.actor === actor
      && !call.continuation)?.stimulus.find(value => value.content.actionType === 'move'
        && value.content.actorId === 'character:player')?.content.movement
    expect(returnStimulus('character:friend')).toEqual({ characterId: 'character:player',
      toLocationId: 'location:front-room' })
    expect(returnStimulus('character:companion')).toEqual({ characterId: 'character:player',
      fromLocationId: 'location:back-room' })

    const beforeClaim = events().filter(event => event.eventType === 'entity.transferred').length
    expect(calls.every(call => call.observationSeqs.every((seq, index) =>
      index === 0 || call.observationSeqs[index - 1]! <= seq))).toBe(true)
    await submit('claim', '/act speak {"text":"我说钥匙已经交给留守者了，但这只是我的说法。"}')
    expect(events().filter(event => event.eventType === 'entity.transferred')).toHaveLength(beforeClaim)
    expect(currentEntityState(events(), 'entity:brass-key')?.holderId).toBe('character:companion')
  } finally {
    if (runtime !== undefined) await runtime.close()
    await new Promise<void>(done => server.close(() => done()))
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
