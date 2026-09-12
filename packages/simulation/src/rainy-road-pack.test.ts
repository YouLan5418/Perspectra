import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SceneDecisionService, WorldApplication } from '@harness-world/application'
import {
  brandId,
  PHASE8_REGISTRY_LOCKS,
  PHASE8_VOCABULARY_LOCKS,
  type FaultInjector,
  type FaultPoint,
  type ProposalContext,
} from '@harness-world/contracts'
import { currentEntityState, currentLocation, WorldBootstrap } from '@harness-world/kernel'
import { WorldHealthService } from '@harness-world/operations'
import {
  BranchAdministration,
  CharacterRuntimeAvailabilityService,
  CognitionProjectionRebuilder,
  WorldStore,
} from '@harness-world/store-sqlite'
import {
  RAINY_ROAD_IDS,
  adaptRainyRoadPack,
  compileRainyRoadPack,
  createRainyRoadParticipants,
  rainyRoadSourceDirectory,
  type RainyRoadFixtureEvidence,
} from './rainy-road-pack.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rainy-road-pack-'))
  roots.push(root)
  return root
}

function providerMessages(context: ProposalContext): readonly string[] {
  return (context as unknown as { exactProviderRequest: { messages: readonly { content: string }[] } })
    .exactProviderRequest.messages.map(message => message.content)
}

function commonMessagePrefix(left: ProposalContext, right: ProposalContext): number {
  const leftMessages = providerMessages(left)
  const rightMessages = providerMessages(right)
  let length = 0
  while (leftMessages[length] !== undefined && leftMessages[length] === rightMessages[length]) length += 1
  return length
}

class OneShotRainyRoadFailure implements FaultInjector {
  #armed = false
  #fired = false

  constructor(private readonly target: FaultPoint) {}

  arm(): void {
    this.#armed = true
  }

  hit(point: FaultPoint): void {
    if (!this.#armed || point !== this.target || this.#fired) return
    this.#fired = true
    throw new Error(`rainy-road fault at ${point}`)
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Phase 8 rainy-road acceptance Pack source', () => {
  it('compiles a stable non-specialized Manifest v4 and cognition boundary', async () => {
    const source = await temporaryRoot()
    await cp(rainyRoadSourceDirectory(), source, { recursive: true })
    const pack = await compileRainyRoadPack(source)
    expect(pack).toMatchObject({
      compiledSchemaVersion: 'worldpack/v2',
      packId: 'pack:rainy-road-companions',
      packVersion: '1.0.0',
      content: {
        world: { title: '雨夜同行' },
        characters: [
          { characterId: RAINY_ROAD_IDS.alice },
          { characterId: RAINY_ROAD_IDS.bob },
          { characterId: RAINY_ROAD_IDS.player },
        ],
      },
      vocabularyLocks: PHASE8_VOCABULARY_LOCKS,
      registryLocks: PHASE8_REGISTRY_LOCKS,
    })
    expect(pack.packHash).toBe('sha256:76098df56b8a9169861f5094159d41ee7d6ef26c018339c8017615eb4686e0b8')
    expect(JSON.stringify(pack)).not.toMatch(/investigation|evidence|accuse|travel_action/iu)

    const address = {
      tenantId: brandId('tenant:rainy-road', 'TenantId'),
      worldId: brandId('world:rainy-road', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const compiled = adaptRainyRoadPack(pack, address)
    expect(compiled.manifest).toMatchObject({
      schemaVersion: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
      contentPack: {
        runtimeCapabilities: {
          cognitionProjectionVersion: 1,
          sceneDecisionVersion: 2,
          cognitiveMemoryVersion: 2,
          agentContextVersion: 2,
        },
      },
    })
    const store = new WorldStore(join(source, 'world.sqlite'))
    try {
      new WorldBootstrap(store).activate(compiled)
      const cognition = new CognitionProjectionRebuilder(store)
      const head = store.head(address)
      const alice = cognition.rebuildCharacterAt(address, RAINY_ROAD_IDS.alice, head.headSeq)
      const bob = cognition.rebuildCharacterAt(address, RAINY_ROAD_IDS.bob, head.headSeq)
      const player = cognition.rebuildCharacterAt(address, RAINY_ROAD_IDS.player, head.headSeq)
      expect(JSON.stringify(alice)).toContain('is_irresponsible')
      expect(JSON.stringify(alice)).toContain('competence')
      expect(JSON.stringify(alice)).toContain('honesty')
      expect(JSON.stringify(bob)).toContain('late_because_helped_injured_stranger')
      expect(JSON.stringify(alice)).not.toContain('late_because_helped_injured_stranger')
      expect(JSON.stringify(player)).not.toContain('late_because_helped_injured_stranger')
    } finally {
      store.close()
    }
  })

  it('does not depend on the repository source directory after compilation', async () => {
    const source = await temporaryRoot()
    await cp(rainyRoadSourceDirectory(), source, { recursive: true })
    const pack = await compileRainyRoadPack(source)
    await rm(source, { recursive: true, force: true })
    expect(adaptRainyRoadPack(pack, {
      tenantId: brandId('tenant:rainy-road-copy', 'TenantId'),
      worldId: brandId('world:rainy-road-copy', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }).manifest.contentPack?.packHash).toBe(pack.packHash)
  })

  it('runs six deterministic Rounds with private speech, Scene scheduling, Reflection, Memory and fork isolation', async () => {
    const root = await temporaryRoot()
    const pack = await compileRainyRoadPack()
    const parent = {
      tenantId: brandId('tenant:rainy-road-e2e', 'TenantId'),
      worldId: brandId('world:rainy-road-e2e', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const child = { ...parent, branchId: brandId('branch:before-private', 'BranchId') }
    const compiled = adaptRainyRoadPack(pack, parent)
    const evidence: RainyRoadFixtureEvidence = { calls: new Map(), contexts: new Map() }
    const application = new WorldApplication({
      worldPath: join(root, 'world.sqlite'),
      sessionPath: join(root, 'session.sqlite'),
      memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 100,
      participants: () => createRainyRoadParticipants(evidence),
    })
    const submit = (turn: number, action: { actionType: string; parameters: Record<string, unknown> }) => application.submit(parent, {
      idempotencyKey: `rainy-road:turn:${turn}`,
      principalId: RAINY_ROAD_IDS.principal,
      action: action as never,
      correlationId: `rainy-road:turn:${turn}`,
    })
    try {
      expect(application.activate(compiled).status).toBe('activated')
      const first = await submit(1, {
        actionType: 'speak',
        parameters: { text: 'Bob，你为什么迟到？', addresseeIds: [], scope: 'scene_public', replyTo: null, declaredSpeechAct: 'question' },
      })
      expect(first).toMatchObject({ status: 'accepted', tick: 1 })
      await application.deliver(parent, 'rainy-road:deliver:before-fork')
      expect((await application.forkAtHead(parent, child, 'before Bob private answer', 'rainy-road:fork')).forkSeq)
        .toBe(first.headSeq)

      await submit(2, {
        actionType: 'speak',
        parameters: {
          text: 'Bob，可以单独告诉我吗？', addresseeIds: [RAINY_ROAD_IDS.bob], scope: 'private',
          replyTo: null, declaredSpeechAct: 'question',
        },
      })
      expect(JSON.stringify(await application.recallMemory(parent, RAINY_ROAD_IDS.player, 'bob'))).toContain('受伤')
      expect(JSON.stringify(await application.recallMemory(parent, RAINY_ROAD_IDS.alice, 'bob'))).not.toContain('受伤')
      expect(JSON.stringify(await application.recallMemory(child, RAINY_ROAD_IDS.player, 'bob'))).not.toContain('受伤')

      await submit(3, { actionType: 'speak', parameters: { text: '你先去车站看看，我们随后来。' } })
      await submit(4, { actionType: 'speak', parameters: { text: 'Alice，我们先整理一下再出发。' } })
      expect(evidence.calls.get('agent:bob')).toBe(3)
      await submit(5, {
        actionType: 'speak',
        parameters: { text: 'Bob 说他因为帮助一名受伤的陌生人才迟到。', declaredSpeechAct: 'report' },
      })
      expect(evidence.calls.get('agent:bob')).toBe(3)
      expect(JSON.stringify(await application.recallMemory(parent, RAINY_ROAD_IDS.alice, 'bob'))).toContain('受伤')

      const sixth = await submit(6, { actionType: 'move', parameters: { locationId: RAINY_ROAD_IDS.station } })
      expect(sixth).toMatchObject({ status: 'accepted', tick: 6 })
      expect(evidence.calls).toEqual(new Map([['agent:alice', 6], ['agent:bob', 3]]))
      const events = await application.eventHistory(parent)
      expect(currentLocation(events, RAINY_ROAD_IDS.player)).toBe(RAINY_ROAD_IDS.station)
      expect(currentLocation(events, RAINY_ROAD_IDS.alice)).toBe(RAINY_ROAD_IDS.station)
      expect(currentLocation(events, RAINY_ROAD_IDS.bob)).toBe(RAINY_ROAD_IDS.station)
      expect(currentEntityState(events, RAINY_ROAD_IDS.tickets)).toMatchObject({ holderId: RAINY_ROAD_IDS.alice })
      expect(events.filter(event => event.eventType === 'scene.activated')).toMatchObject([
        { data: { sceneId: 'scene:station-platform' } },
      ])
      expect(events.filter(event => event.eventType === 'scene.closed')).toMatchObject([
        { data: { sceneId: 'scene:road-shelter' } },
      ])
      expect(events.filter(event => event.eventType === 'scene.member_joined')).toHaveLength(3)
      expect(events.filter(event => event.eventType === 'scene.member_left')).toHaveLength(3)

      const verificationStore = new WorldStore(join(root, 'world.sqlite'))
      const cognition = new CognitionProjectionRebuilder(verificationStore)
        .rebuildCharacterAt(parent, RAINY_ROAD_IDS.alice, sixth.headSeq)
      const verificationAvailability = new CharacterRuntimeAvailabilityService(join(root, 'world.sqlite'))
      expect(new SceneDecisionService(verificationStore, verificationAvailability, 2)
        .decide(parent, RAINY_ROAD_IDS.player, sixth.headSeq)).toMatchObject({
        sceneId: 'scene:station-platform',
        schedulableCharacterIds: [RAINY_ROAD_IDS.alice, RAINY_ROAD_IDS.bob],
      })
      verificationAvailability.close()
      verificationStore.close()
      const trust = cognition.relationships.find(record =>
        (record.value as Record<string, unknown>).type === 'trust')!
      const distrust = cognition.relationships.find(record =>
        (record.value as Record<string, unknown>).type === 'distrust')!
      expect(trust.value).toMatchObject({ facet: 'competence', intensityPermille: 720, status: 'active' })
      expect(distrust.value).toMatchObject({ facet: 'honesty', intensityPermille: 580, status: 'active' })
      expect(events.filter(event => event.eventType === 'character.reflect')).toHaveLength(1)

      const observations = events.filter(event => event.eventType === 'observation.upsert')
        .map(event => (event.data as Record<string, unknown>).value as Record<string, unknown>)
      const alicePrivateOccurrence = observations.find(value => value.observerId === RAINY_ROAD_IDS.alice
        && JSON.stringify(value).includes('private_interaction'))
      expect(alicePrivateOccurrence).toBeDefined()
      expect(JSON.stringify(alicePrivateOccurrence)).not.toContain('受伤')
      expect(JSON.stringify(evidence.contexts.get('agent:alice'))).not.toContain('late_because_helped_injured_stranger')
      expect(JSON.stringify(evidence.contexts.get('agent:bob')?.[0])).toContain('late_because_helped_injured_stranger')
      const aliceContexts = evidence.contexts.get('agent:alice')!
      const bobContexts = evidence.contexts.get('agent:bob')!
      // The reusable cache prefix is the four segments before the Continuity baseline: Host protocol,
      // controller contract, world anchor and character anchor. The baseline now advances with the Tail
      // window, so it is no longer stable across Rounds and cannot sit inside a cached prefix.
      expect(commonMessagePrefix(aliceContexts[0]!, aliceContexts[1]!)).toBe(4)
      expect(commonMessagePrefix(bobContexts[0]!, bobContexts[1]!)).toBe(4)
      expect(commonMessagePrefix(aliceContexts[0]!, bobContexts[0]!)).toBe(3)
      expect(providerMessages(aliceContexts[0]!)[3]).toBe(providerMessages(aliceContexts[5]!)[3])
      expect(providerMessages(aliceContexts[0]!)[4]).not.toBe(providerMessages(aliceContexts[5]!)[4])

      const callsBeforeReplay = new Map(evidence.calls)
      expect(await submit(1, {
        actionType: 'speak',
        parameters: { text: 'Bob，你为什么迟到？', addresseeIds: [], scope: 'scene_public', replyTo: null, declaredSpeechAct: 'question' },
      })).toEqual(first)
      expect(evidence.calls).toEqual(callsBeforeReplay)
      const unscheduledBob = createRainyRoadParticipants()[1]!
      expect(await unscheduledBob.provider.propose(evidence.contexts.get('agent:alice')![3]!)).toEqual({
        schemaVersion: 2, decision: 'abstain', actions: [],
      })
    } finally {
      await application.close()
    }

    const restartedEvidence: RainyRoadFixtureEvidence = { calls: new Map(), contexts: new Map() }
    const restarted = new WorldApplication({
      worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 100, participants: () => createRainyRoadParticipants(restartedEvidence),
    })
    try {
      expect(restarted.activate(compiled).status).toBe('already_active')
      expect(await restarted.submit(parent, {
        idempotencyKey: 'rainy-road:turn:1', principalId: RAINY_ROAD_IDS.principal,
        action: {
          actionType: 'speak',
          parameters: { text: 'Bob，你为什么迟到？', addresseeIds: [], scope: 'scene_public', replyTo: null, declaredSpeechAct: 'question' },
        },
        correlationId: 'rainy-road:turn:1',
      })).toMatchObject({ tick: 1 })
      expect(restartedEvidence.calls.size).toBe(0)
      const childEvents = await restarted.eventHistory(child)
      expect(Math.max(...childEvents.map(event => event.tick))).toBe(1)
      expect(childEvents.some(event => event.eventType === 'character.speak'
        && JSON.stringify(event.data).includes('受伤的陌生人'))).toBe(false)
    } finally {
      await restarted.close()
    }
  })

  it.each(['provider-timeout', 'memory-catchup-failure'] as const)(
    'keeps the player Round live and recovers from %s without invented participant effects',
    async mode => {
      const root = await temporaryRoot()
      const pack = await compileRainyRoadPack()
      const address = {
        tenantId: brandId(`tenant:rainy-road:${mode}`, 'TenantId'),
        worldId: brandId('world:rainy-road-degradation', 'WorldId'),
        branchId: brandId('branch:main', 'BranchId'),
      }
      const compiled = adaptRainyRoadPack(pack, address)
      let failProvider = mode === 'provider-timeout'
      let aliceDispatches = 0
      const memoryFailure = new OneShotRainyRoadFailure('memory.after-catchup-commit')
      const participants = () => {
        const base = createRainyRoadParticipants()
        return base.map(participant => participant.actorId !== RAINY_ROAD_IDS.alice ? participant : {
          ...participant,
          timeoutMs: 5,
          provider: {
            async propose(context: ProposalContext) {
              aliceDispatches += 1
              if (failProvider) return new Promise<never>(() => undefined)
              return participant.provider.propose(context)
            },
          },
        })
      }
      const application = new WorldApplication({
        worldPath: join(root, 'world.sqlite'),
        sessionPath: join(root, 'session.sqlite'),
        memoryPath: join(root, 'memory.sqlite'),
        modelBudgetTokens: 100,
        participants,
        ...(mode === 'memory-catchup-failure' ? { faultInjector: memoryFailure } : {}),
      })
      const firstRequest = {
        idempotencyKey: `rainy-road:${mode}:1`, principalId: RAINY_ROAD_IDS.principal,
        action: { actionType: 'speak', parameters: { text: '我们继续赶路。' } },
        correlationId: `rainy-road:${mode}:1`,
      }
      try {
        expect(application.activate(compiled).status).toBe('activated')
        await application.head(address)
        memoryFailure.arm()
        const first = await application.submit(address, firstRequest)
        expect(first).toMatchObject({ status: 'accepted', tick: 1 })
        const events = await application.eventHistory(address)
        const expectedTerminal = mode === 'provider-timeout' ? 'provider_timeout' : 'runtime_unavailable'
        expect(events).toContainEqual(expect.objectContaining({
          tick: 1,
          eventType: 'round.participant-terminal',
          data: expect.objectContaining({ participantId: 'agent:alice', status: expectedTerminal, actionCount: 0 }),
        }))
        expect(events.some(event => event.tick === 1 && event.eventType === 'character.speak'
          && (event.data as Record<string, unknown>).characterId === RAINY_ROAD_IDS.alice)).toBe(false)
        expect(new WorldHealthService(join(root, 'world.sqlite')).check()).toMatchObject({
          status: 'ready', branches: [expect.objectContaining({
            status: 'degraded', readyForWrite: true, readyForAgentCalls: false,
          })],
        })
        expect(application.runtimeMetrics.snapshot()).toMatchObject({
          participantTerminals: { [expectedTerminal]: 1 },
        })
        expect(await application.recallMemory(address, RAINY_ROAD_IDS.alice, 'rainy-road')).toEqual([])
        const administration = new BranchAdministration(join(root, 'world.sqlite'))
        expect(administration.readAudit(address)).toContainEqual(expect.objectContaining({
          operation: 'round.committed',
          details: expect.objectContaining({
            participantTerminals: expect.arrayContaining([
              expect.objectContaining({ participantId: 'agent:alice', terminalStatus: expectedTerminal }),
            ]),
          }),
        }))
        administration.close()
        const callsBeforeReplay = aliceDispatches
        expect(await application.submit(address, firstRequest)).toEqual(first)
        expect(aliceDispatches).toBe(callsBeforeReplay)

        failProvider = false
        await application.setCharacterAvailability(address, RAINY_ROAD_IDS.alice, 'ready', null)
        expect(await application.submit(address, {
          idempotencyKey: `rainy-road:${mode}:2`, principalId: RAINY_ROAD_IDS.principal,
          action: { actionType: 'speak', parameters: { text: '恢复后继续。' } },
          correlationId: `rainy-road:${mode}:2`,
        })).toMatchObject({ status: 'accepted', tick: 2 })
        expect(aliceDispatches).toBe(callsBeforeReplay + 1)
        expect(new WorldHealthService(join(root, 'world.sqlite')).check().branches[0]?.status).toBe('healthy')
      } finally {
        await application.close()
      }
    },
  )
})
