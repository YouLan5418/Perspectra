import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import {
  brandId,
  hashWorldJson,
  type CharacterId,
  type FaultInjector,
  type SubmitActionsV2,
} from '@harness-world/contracts'
import { type CompiledWorldSpec } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import {
  ADDRESS,
  reactionBinding,
  roundProvider,
  v5Manifest,
  type ProviderScript,
} from './reaction-fixture.ts'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function directory(label: string) {
  const root = mkdtempSync(join(tmpdir(), `hcw-reaction-e2e-${label}-`))
  roots.push(root)
  return root
}

function reactionSpeech(actorId: CharacterId, wave: number, text: string): SubmitActionsV2 {
  return {
    schemaVersion: 2,
    decision: 'act',
    actions: [{
      actionId: `action:${actorId}:reaction:${wave}`,
      actorId,
      actionType: 'speak',
      actionVersion: 1,
      parameters: { text },
    }],
  }
}

function v4Manifest(): CompiledWorldSpec {
  const v5 = v5Manifest()
  const { reactionPolicy: _, ...rest } = v5.manifest as Record<string, unknown>
  const manifest = { ...rest, schemaVersion: 4 as const } as CompiledWorldSpec['manifest']
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = v5.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { ...(event.data as Record<string, unknown>), manifestHash } }
    : event)
  return { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
}

export function request(idempotencyKey: string, text = idempotencyKey) {
  return {
    idempotencyKey,
    principalId: 'principal:player',
    action: { actionType: 'speak', parameters: { text } },
    correlationId: idempotencyKey,
  } as const
}

describe('Phase 9B reaction end-to-end', () => {
  it('creates a Reaction Cycle atomically with the Root Round and drains it through the application', async () => {
    const dir = directory('full-cycle')
    const worldPath = join(dir, 'world.sqlite')
    const sessionPath = join(dir, 'session.sqlite')
    const memoryPath = join(dir, 'memory.sqlite')

    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')

    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }

    const faultInjector: FaultInjector = { hit: () => {} }
    const compiled = v5Manifest()
    const application = new WorldApplication({
      worldPath,
      sessionPath,
      memoryPath,
      modelBudgetTokens: 64,
      leaseTtlMs: 30_000,
      faultInjector,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)
    const genesisProbe = new WorldStore(worldPath)
    try {
      expect(genesisProbe.verifyBranchIntegrity(ADDRESS).tick).toBe(0)
    } finally {
      genesisProbe.close()
    }

    try {
      const submitResult = await application.submit(ADDRESS, request('e2e:first', 'Hello everyone'))
      expect(submitResult.status).toBe('accepted')

      await expect(application.submit(ADDRESS, request('e2e:first', 'Hello everyone')))
        .resolves.toEqual(submitResult)

      const cycles = await application.listReactionCycles(ADDRESS)
      expect(cycles.length).toBe(1)
      expect(cycles[0]!.status).toBe('active')
      const cycleId = cycles[0]!.cycleId
      const rootProbe = new WorldStore(worldPath)
      try {
        const rootCycle = rootProbe.activeReactionCycle(ADDRESS)!
        expect(rootProbe.committedRound(ADDRESS, rootCycle.cycle.rootTransactionId)).toBeDefined()
      } finally {
        rootProbe.close()
      }
      aliceScript.outputs.set(`${cycleId}:1:${alice}`, reactionSpeech(alice, 1, 'Alice reacts'))
      bobScript.outputs.set(`${cycleId}:2:${bob}`, reactionSpeech(bob, 2, 'Bob answers Alice'))

      const drain = await application.processReactionCycles(ADDRESS)
      expect(drain).not.toBeNull()
      expect(drain!.cycleId).toBe(cycleId)
      expect(drain!.waves.map(wave => [wave.wave, wave.actionCount, wave.terminalReason])).toEqual([
        [1, 1, null],
        [2, 1, null],
        [3, 0, 'all_abstained'],
      ])
      expect(aliceScript.calls.value).toBe(2)
      expect(bobScript.calls.value).toBe(2)
      const eventStore = new WorldStore(worldPath)
      try {
        const speeches = eventStore.readEvents(ADDRESS)
          .filter(event => event.eventType === 'character.speak')
          .map(event => (event.data as { readonly text: string }).text)
        expect(speeches).toEqual(expect.arrayContaining(['Alice reacts', 'Bob answers Alice']))
      } finally {
        eventStore.close()
      }

      const afterDrain = await application.listReactionCycles(ADDRESS)
      expect(afterDrain[0]!.status).toBe('terminal')

      const postDrain = await application.processReactionCycles(ADDRESS)
      expect(postDrain).toMatchObject({ cycleId: null, waves: [] })
    } finally {
      await application.close()
    }
  })

  it('does not create a Reaction Cycle for Manifest V4', async () => {
    const dir = directory('v4-no-cycle')
    const worldPath = join(dir, 'world.sqlite')
    const sessionPath = join(dir, 'session.sqlite')
    const memoryPath = join(dir, 'memory.sqlite')

    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')

    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }

    const compiled = v4Manifest()
    const application = new WorldApplication({
      worldPath,
      sessionPath,
      memoryPath,
      modelBudgetTokens: 64,
      leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)

    try {
      await application.submit(ADDRESS, request('v4:first', 'Hello'))
      await application.processAcceptedRounds(ADDRESS, 'v4:process')

      const cycles = await application.listReactionCycles(ADDRESS)
      expect(cycles.length).toBe(0)

      const drain = await application.processReactionCycles(ADDRESS)
      expect(drain).toBeNull()
    } finally {
      await application.close()
    }
  })

  it('settles the previous Cycle before a newly submitted Root Round creates the next one', async () => {
    const dir = directory('player-preemption')
    const worldPath = join(dir, 'world.sqlite')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const compiled = v5Manifest()
    const application = new WorldApplication({
      worldPath,
      sessionPath: join(dir, 'session.sqlite'),
      memoryPath: join(dir, 'memory.sqlite'),
      modelBudgetTokens: 64,
      leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)
    try {
      await application.submit(ADDRESS, request('preempt:first'))
      const first = (await application.listReactionCycles(ADDRESS))[0]!
      expect(first.status).toBe('active')

      await application.submit(ADDRESS, request('preempt:second'))
      const cycles = await application.listReactionCycles(ADDRESS)
      expect(cycles).toHaveLength(2)
      expect(cycles.find(cycle => cycle.cycleId === first.cycleId)).toMatchObject({
        status: 'terminal',
        terminalReason: 'player_preempted',
      })
      expect(cycles.find(cycle => cycle.cycleId !== first.cycleId)).toMatchObject({ status: 'active' })
    } finally {
      await application.close()
    }
  })

  it('interleaves a complete Cycle between Root Rounds that were queued together', async () => {
    const dir = directory('queued-roots')
    const worldPath = join(dir, 'world.sqlite')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const compiled = v5Manifest()
    const application = new WorldApplication({
      worldPath,
      sessionPath: join(dir, 'session.sqlite'),
      memoryPath: join(dir, 'memory.sqlite'),
      modelBudgetTokens: 64,
      leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)
    try {
      await application.acceptRound(ADDRESS, request('queued:first'))
      await application.acceptRound(ADDRESS, request('queued:second'))
      await expect(application.processAcceptedRounds(ADDRESS, 'queued:process')).resolves.toBe(2)
      expect(await application.listReactionCycles(ADDRESS)).toMatchObject([
        { status: 'terminal', terminalReason: 'all_abstained' },
        { status: 'terminal', terminalReason: 'all_abstained' },
      ])
    } finally {
      await application.close()
    }
  })

  it('drains an earlier accepted Root and its Cycle before returning a directly submitted Root', async () => {
    const dir = directory('accepted-before-submit')
    const worldPath = join(dir, 'world.sqlite')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const application = new WorldApplication({
      worldPath,
      sessionPath: join(dir, 'session.sqlite'),
      memoryPath: join(dir, 'memory.sqlite'),
      modelBudgetTokens: 64,
      leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(v5Manifest())
    try {
      await application.acceptRound(ADDRESS, request('accepted:earlier'))
      await expect(application.submit(ADDRESS, request('accepted:direct')))
        .resolves.toMatchObject({ status: 'accepted', tick: 3 })
      expect(await application.listReactionCycles(ADDRESS)).toMatchObject([
        { status: 'active' },
        { status: 'terminal', terminalReason: 'all_abstained' },
      ])
    } finally {
      await application.close()
    }
  })

  it('does not create a Reaction Cycle when no reaction participants are scene observers', async () => {
    const dir = directory('no-observers')
    const worldPath = join(dir, 'world.sqlite')
    const sessionPath = join(dir, 'session.sqlite')
    const memoryPath = join(dir, 'memory.sqlite')

    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')

    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }

    const base = v5Manifest()
    const characters = base.manifest.characters.map(character => ({
      ...character,
      controllerClass: character.characterId === 'character:player' ? 'manual' as const : 'scripted' as const,
      pronouns: 'they',
      lifecycle: 'active' as const,
      portrayal: null,
    }))
    const player = brandId('character:player', 'CharacterId')
    const scenes = [{
      sceneId: 'scene:room',
      lifecycle: 'active' as const,
      locationId: 'location:room',
      participantIds: [player],
    }]
    const manifest = {
      ...base.manifest,
      characters,
      scenes,
    }
    const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
    const genesisEvents = base.genesisEvents.map(event => {
      if (event.eventType === 'world.manifest-locked') {
        return { ...event, data: { ...(event.data as Record<string, unknown>), manifestHash } }
      }
      if (event.eventType !== 'scene.upsert') return event
      return {
        ...event,
        data: {
          sceneId: 'scene:room',
          value: { lifecycle: 'active', locationId: 'location:room', participantIds: [player] },
        },
      }
    })
    const compiled: CompiledWorldSpec = {
      manifest,
      manifestHash,
      genesisEvents,
      genesisHash: hashWorldJson('world-genesis-plan', genesisEvents),
    }

    const application = new WorldApplication({
      worldPath,
      sessionPath,
      memoryPath,
      modelBudgetTokens: 64,
      leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)

    try {
      await application.submit(ADDRESS, request('no-obs:first', 'Hello'))
      await application.processAcceptedRounds(ADDRESS, 'no-obs:process')

      const cycles = await application.listReactionCycles(ADDRESS)
      expect(cycles.length).toBe(0)
    } finally {
      await application.close()
    }
  })

  it('fails closed when responsive/v1 has no Reaction participant bindings', async () => {
    const dir = directory('no-reaction-participants')
    const worldPath = join(dir, 'world.sqlite')
    const sessionPath = join(dir, 'session.sqlite')
    const memoryPath = join(dir, 'memory.sqlite')

    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')

    const compiled = v5Manifest()
    const application = new WorldApplication({
      worldPath,
      sessionPath,
      memoryPath,
      modelBudgetTokens: 64,
      leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'round alice'), roundProvider(bob, 'round bob')],
    })
    application.activate(compiled)

    try {
      await expect(application.submit(ADDRESS, request('no-rp:first', 'Hello')))
        .rejects.toThrow('requires one Reaction participant binding')
    } finally {
      await application.close()
    }
  })
})
