import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { brandId, hashWorldJson, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry, currentEntityState } from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { CharacterTurn, type CharacterTurnRequest } from '@harness-world/application'
import { officialCharacterLoop } from '@harness-world/official-character-loop'
import type { CharacterLoopActivation, CharacterLoopInstance } from '@harness-world/plugin-sdk'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) close()
})
const npc = brandId('character:npc', 'CharacterId')
const bob = brandId('character:bob', 'CharacterId')
const speech = { decision: 'publish', segments: [{ type: 'speech', text: '收到。' }] }
const take = {
  decision: 'perform',
  actionType: 'interact',
  parameters: {
    targetRef: { kind: 'entity', id: 'entity:cup' },
    bindingId: 'binding:entity:cup:base:take',
    definitionRef: { id: 'base:take', version: 1 },
    arguments: {},
  },
}

function fixture(
  loop: CharacterLoopInstance,
  decide: (request: CharacterTurnRequest) => Promise<unknown> = async () => speech,
  extra: readonly WorldEventDraft[] = [],
) {
  const directory = mkdtempSync(join(tmpdir(), 'character-loop-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'world.sqlite')
  const store = new WorldStore(path),
    leases = new WriterLeaseService(path),
    availability = new CharacterRuntimeAvailabilityService(path)
  cleanup.push(() => {
    availability.close()
    leases.close()
    store.close()
  })
  const world = frozenInteractionWorld(),
    address = world.manifest.address
  const genesisEvents = [...world.genesisEvents, ...extra]
  store.activateBranch({
    ...world,
    genesisEvents,
    genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
    address,
    transactionId: brandId('transaction:genesis', 'TransactionId'),
    roundId: brandId('round:genesis', 'InteractionRoundId'),
    correlationId: 'test',
  })
  const options = {
    address,
    store,
    leases,
    availability,
    rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
    decide,
  }
  return { store, address, options, turn: new CharacterTurn({ ...options, loop }) }
}

it('keeps actor, request and result authority inside the activation', async () => {
  const decide = vi.fn(async (request: CharacterTurnRequest) => {
    expect((request.context.character as WorldJsonObject).characterId).toBe(npc)
    return take
  })
  const f = fixture(
    {
      async run(a) {
        expect(Object.keys(a)).not.toContain('store')
        const exposed = a.prepare({ canPerform: true, continuation: false })
        Object.assign(exposed.context.character as WorldJsonObject, { characterId: bob })
        const result = await a.submit(await a.decide())
        expect(result).toMatchObject({ decision: 'perform', status: 'accepted', controlledCommitted: true })
        Object.assign(a.performResult!, { status: 'forged' })
        a.prepare({ canPerform: false, continuation: true })
        const published = await a.submit(speech)
        expect(published.status).toBe('accepted')
        return 'published'
      },
    },
    decide,
  )
  expect(await f.turn.run(npc)).toMatchObject({ status: 'published', calls: 1, performResult: { status: 'accepted' } })
  expect(currentEntityState(f.store.readEvents(f.address), 'entity:cup')?.holderId).toBe(npc)
})

it('consumes each prepared request once and invalidates capabilities after run', async () => {
  let saved!: CharacterLoopActivation
  const f = fixture({
    async run(a) {
      saved = a
      a.prepare({ canPerform: false, continuation: false })
      await a.submit(speech)
      await expect(a.submit(speech)).rejects.toThrow('prepare')
      return 'published'
    },
  })
  await f.turn.run(npc)
  expect(() => saved.prepare({ canPerform: true, continuation: true })).toThrow('ended')
  expect(() => saved.submit(speech)).toThrow('ended')
  expect(() => saved.decide()).toThrow('ended')
  expect(f.store.readEvents(f.address).filter(e => e.eventType === 'character.speak')).toHaveLength(1)
})

it('does not turn a plugin success claim into a published world fact', async () => {
  const f = fixture({ run: async () => 'published' })
  const before = f.store.head(f.address)
  await expect(f.turn.run(npc)).resolves.toMatchObject({ status: 'failed', calls: 0 })
  expect(f.store.head(f.address)).toEqual(before)
})

it('cancels and settles a decision the loop abandoned without blaming the model', async () => {
  let settled = false
  const onLoopFailure = vi.fn()
  const onTrace = vi.fn()
  const f = fixture(officialCharacterLoop)
  const turn = new CharacterTurn({
    ...f.options,
    onLoopFailure,
    onTrace,
    loop: {
      async run(a) {
        a.prepare({ canPerform: false, continuation: false })
        void a.decide()
        return 'abstained'
      },
    },
    decide: async (_request, signal) => {
      await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }))
      settled = true
      return speech
    },
  })
  expect(await turn.run(npc)).toMatchObject({ status: 'failed', calls: 1 })
  expect(onLoopFailure).toHaveBeenCalledWith(
    npc,
    expect.objectContaining({ message: expect.stringContaining('unfinished') }),
  )
  expect(settled).toBe(true)
  expect(onTrace).toHaveBeenCalledWith('turn', npc, expect.any(String), { status: 'failed', calls: 1 })
  expect(f.store.readEvents(f.address).filter(e => e.eventType === 'character.speak')).toEqual([])
})

it('does not mask a context storage fault after a loop catches an earlier model failure', async () => {
  const f = fixture(
    {
      async run(a) {
        a.prepare({ canPerform: false, continuation: false })
        await expect(a.decide()).rejects.toThrow('model offline')
        vi.spyOn(f.store, 'readEvents').mockImplementationOnce(() => {
          throw new Error('context storage failed')
        })
        a.prepare({ canPerform: false, continuation: true })
        return 'abstained'
      },
    },
    async () => {
      throw new Error('model offline')
    },
  )
  await expect(f.turn.run(npc)).rejects.toThrow('context storage failed')
})

it.each([
  { ...speech, actorId: 'character:bob' },
  { decision: 'perform', actionType: 'action.resolved', parameters: {} },
  { ...speech, recipientIds: ['character:bob'] },
])('rejects forged actors, events and observation recipients (%j)', async raw => {
  const f = fixture({
    async run(a) {
      a.prepare({ canPerform: true, continuation: false })
      await a.submit(raw)
      return 'published'
    },
  })
  const before = f.store.head(f.address)
  expect(await f.turn.run(npc)).toMatchObject({ status: 'failed', failure: 'invalid_output' })
  expect(f.store.head(f.address)).toEqual(before)
})

it('rejects concurrent activations of the same actor even from separate execution objects', async () => {
  let release!: () => void, started!: () => void
  const ready = new Promise<void>(done => {
    started = done
  })
  const wait = new Promise<void>(done => {
    release = done
  })
  const f = fixture({
    async run() {
      started()
      await wait
      return 'abstained'
    },
  })
  const first = f.turn.run(npc)
  await ready
  try {
    const other = new CharacterTurn({ ...f.options, loop: officialCharacterLoop })
    await expect(other.run(npc)).rejects.toThrow('busy')
    await expect(other.run(brandId('character:player', 'CharacterId'))).rejects.toThrow('declared NPC')
    await expect(other.run(brandId('character:missing', 'CharacterId'))).rejects.toThrow('declared NPC')
  } finally {
    release()
  }
  await first
})

it('rejects stale proposals after another actor changes the prepared prefix', async () => {
  const f = fixture({
    async run(a) {
      a.prepare({ canPerform: true, continuation: false })
      await new CharacterTurn({ ...f.options, loop: officialCharacterLoop }).run(bob)
      await a.submit(take)
      return 'published'
    },
  })
  expect(await f.turn.run(npc)).toMatchObject({ status: 'stale' })
  expect(currentEntityState(f.store.readEvents(f.address), 'entity:cup')?.holderId).not.toBe(npc)
})

it('refuses a canceled submission and permits a later activation', async () => {
  const controller = new AbortController()
  const f = fixture({
    async run(a) {
      a.prepare({ canPerform: true, continuation: false })
      controller.abort()
      await a.submit(take)
      return 'published'
    },
  })
  const before = f.store.head(f.address)
  expect(await f.turn.run(npc, { signal: controller.signal })).toMatchObject({ status: 'interrupted' })
  expect(f.store.head(f.address)).toEqual(before)
  await expect(new CharacterTurn({ ...f.options, loop: officialCharacterLoop }).run(npc)).resolves.toMatchObject({
    status: 'published',
  })
})

it('retains a committed operation after the continuation model fails and never repeats it', async () => {
  const decide = vi.fn(async () => {
    throw new Error('offline')
  })
  const f = fixture(
    {
      async run(a) {
        a.prepare({ canPerform: true, continuation: false })
        await a.submit(take)
        a.prepare({ canPerform: false, continuation: true })
        await a.decide()
        return 'published'
      },
    },
    decide,
  )
  const first = await f.turn.run(npc)
  expect(first).toMatchObject({ status: 'failed', failure: 'provider_failed', performResult: { status: 'accepted' } })
  const actionId = String(first.performResult!.operationId)
  const resumed = new CharacterTurn({
    ...f.options,
    loop: {
      async run(a) {
        const request = a.prepare({ canPerform: true, continuation: false })
        expect(request.canPerform).toBe(false)
        expect(request.result?.status).toBe('accepted')
        await a.submit(speech)
        return 'published'
      },
    },
  })
  expect(
    await resumed.run(npc, {
      continuationOf: { actionId, action: { actionType: 'interact', parameters: take.parameters } },
    }),
  ).toMatchObject({ status: 'published', calls: 0 })
  expect(f.store.readEvents(f.address).filter(e => e.eventType === 'entity.transferred')).toHaveLength(1)
})

it('adjudicates unreachable private recipients without delivering their content', async () => {
  const f = fixture(
    {
      async run(a) {
        a.prepare({ canPerform: false, continuation: false })
        const result = await a.submit({ ...speech, scope: 'private', addresseeIds: ['character:player'] })
        expect(result).toMatchObject({ status: 'rejected', publicationRejected: true })
        const next = a.prepare({ canPerform: false, continuation: true })
        expect(next.result?.status).toBe('rejected')
        return 'failed'
      },
    },
    undefined,
    [
      {
        eventType: 'character.moved',
        eventVersion: 1,
        data: { characterId: 'character:player', fromLocationId: 'location:room', toLocationId: 'location:next' },
      },
      {
        eventType: 'scene.member_left',
        eventVersion: 1,
        data: { sceneId: 'scene:room', characterId: 'character:player' },
      },
    ],
  )
  expect(await f.turn.run(npc)).toMatchObject({ status: 'failed' })
  expect(f.store.readEvents(f.address).filter(e => e.eventType === 'character.speak')).toEqual([])
})
