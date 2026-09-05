import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import {
  brandId,
  createErrorEnvelope,
  hashWorldJson,
  type CharacterId,
  type FaultInjector,
  type SubmitActionsV2,
} from '@harness-world/contracts'
import { type CompiledWorldSpec } from '@harness-world/kernel'
import { BranchQuarantineService, WorldStore, WorldLogicalTransferService } from '@harness-world/store-sqlite'
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
  it('does not schedule a second NPC response to the player stimulus already consumed by the Root Round', async () => {
    const dir = directory('no-player-stimulus-replay')
    const worldPath = join(dir, 'world.sqlite')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const aliceScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const bobScript: ProviderScript = { calls: { value: 0 }, outputs: new Map() }
    const compiled = v5Manifest()
    const bobAbstains = {
      ...roundProvider(bob, 'unused'),
      provider: {
        async propose() {
          return { participantId: 'agent:bob', actions: [] }
        },
      },
    }
    const application = new WorldApplication({
      worldPath,
      sessionPath: join(dir, 'session.sqlite'),
      memoryPath: join(dir, 'memory.sqlite'),
      modelBudgetTokens: 64,
      participants: () => [roundProvider(alice, 'Alice answers once'), bobAbstains],
      reactionParticipants: () => [reactionBinding(alice, aliceScript), reactionBinding(bob, bobScript)],
    })
    application.activate(compiled)
    try {
      await expect(application.submit(ADDRESS, request('e2e:no-player-replay', 'Hello everyone')))
        .resolves.toMatchObject({ status: 'accepted' })
      const probe = new WorldStore(worldPath)
      try {
        expect(probe.activeReactionCycle(ADDRESS)!.jobs.map(job => job.characterId)).toEqual([bob])
      } finally {
        probe.close()
      }
      await application.processReactionCycles(ADDRESS)
      expect(aliceScript.calls.value).toBe(0)
      expect(bobScript.calls.value).toBe(1)
    } finally {
      await application.close()
    }
  })

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

  it('advances exactly one durable quantum per call and keeps Cycle work ahead of player input', async () => {
    const dir = directory('quantum')
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
      const first = await application.acceptRound(ADDRESS, request('quantum:first', 'Hello everyone'))
      expect(first.status).toBe('queued')

      const rootStep = await application.processNextBranchWork(ADDRESS, 'quantum:root')
      if (rootStep.status !== 'player_round') throw new Error('the first quantum must commit the accepted Root Round')
      expect(rootStep.roundId).toBe(first.roundId)
      const cycleId = rootStep.openedCycleId
      expect(cycleId).not.toBeNull()
      aliceScript.outputs.set(`${cycleId}:1:${alice}`, reactionSpeech(alice, 1, 'Alice reacts'))
      bobScript.outputs.set(`${cycleId}:2:${bob}`, reactionSpeech(bob, 2, 'Bob answers Alice'))

      const waveOne = await application.processNextBranchWork(ADDRESS, 'quantum:wave-one')
      expect(waveOne).toMatchObject({
        status: 'reaction_wave', cycleId, wave: 1, rootRoundId: rootStep.roundId,
        actionCount: 1, terminalReason: null,
      })

      const second = await application.acceptRound(ADDRESS, request('quantum:second', 'Interrupt'))
      const waveTwo = await application.processNextBranchWork(ADDRESS, 'quantum:wave-two')
      expect(waveTwo).toMatchObject({
        status: 'reaction_wave', cycleId, wave: 2, rootRoundId: rootStep.roundId,
        actionCount: 0, terminalReason: 'player_preempted',
      })

      const secondStep = await application.processNextBranchWork(ADDRESS, 'quantum:second')
      if (secondStep.status !== 'player_round') throw new Error('the queued player Round must follow the terminal Cycle')
      expect(secondStep.roundId).toBe(second.roundId)

      const trailing: string[] = []
      for (let index = 0; index < 8; index += 1) {
        const step = await application.processNextBranchWork(ADDRESS, 'quantum:trailing')
        trailing.push(step.status)
        if (step.status === 'idle') break
      }
      expect(trailing.at(-1)).toBe('idle')
      expect(trailing.every(status => status !== 'player_round')).toBe(true)

      await expect(application.processNextReactionWave(ADDRESS)).resolves.toMatchObject({ status: 'idle' })
    } finally {
      await application.close()
    }
  })

  it('quiesces open Cycles before maintenance and never resurrects them', async () => {
    const dir = directory('maintenance')
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
      await application.submit(ADDRESS, request('maintenance:first', 'Hello everyone'))
      const opened = await application.listReactionCycles(ADDRESS)
      expect(opened).toHaveLength(1)
      expect(opened[0]!.status).toBe('active')
      await application.acceptRound(ADDRESS, request('maintenance:queued', 'Queued while reacting'))
      await application.acceptRound(ADDRESS, request('maintenance:queued-second', 'Another queued input'))

      const result = await application.enterMaintenance(ADDRESS, 'planned maintenance', 'maintenance:enter')
      expect(result.state).toMatchObject({ runtimePhase: 'maintenance', admissionState: 'draining' })
      expect(result.drainedRounds).toBe(2)
      expect(result.settledWaves).toBe(3)
      expect(typeof result.stoppedCycleId).toBe('string')

      const cycles = await application.listReactionCycles(ADDRESS)
      expect(cycles).toHaveLength(3)
      expect(cycles.every(cycle => cycle.status === 'terminal')).toBe(true)
      expect(cycles.find(cycle => cycle.cycleId === opened[0]!.cycleId))
        .toMatchObject({ terminalReason: 'player_preempted' })
      expect(cycles.find(cycle => cycle.cycleId !== opened[0]!.cycleId))
        .toMatchObject({ terminalReason: 'administrative_stop' })
      expect(aliceScript.calls.value).toBe(0)
      expect(bobScript.calls.value).toBe(0)

      await application.exitMaintenance(ADDRESS, 'maintenance complete', 'maintenance:exit')
      expect(await application.branchStatus(ADDRESS)).toMatchObject({ runtimePhase: 'active', admissionState: 'open' })
      const afterExit = await application.listReactionCycles(ADDRESS)
      expect(afterExit.every(cycle => cycle.status === 'terminal')).toBe(true)
    } finally {
      await application.close()
    }
  })

  it('refuses archive and fork with a retryable error while a Cycle is still open', async () => {
    const dir = directory('archive-fork-barrier')
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
      await application.submit(ADDRESS, request('barrier:first', 'Hello everyone'))
      expect((await application.listReactionCycles(ADDRESS))[0]!.status).toBe('active')
      const child = { ...ADDRESS, branchId: brandId('branch:barrier-child', 'BranchId') }
      for (const attempt of [
        () => application.forkAtHead(ADDRESS, child, 'barrier fork', 'barrier:fork'),
        () => application.archive(ADDRESS, 'barrier archive', 'barrier:archive'),
      ]) {
        await expect(attempt()).rejects.toMatchObject({
          envelope: { errorCode: 'BRANCH_DRAINING', retryable: true },
        })
      }
      expect((await application.listReactionCycles(ADDRESS))[0]!.status).toBe('active')
      await application.processReactionCycles(ADDRESS)
      const fork = await application.forkAtHead(ADDRESS, child, 'barrier fork complete', 'barrier:fork-complete')
      expect(fork.forkSeq).toBe((await application.head(ADDRESS)).headSeq)
      expect(await application.listReactionCycles(child)).toEqual([])
      expect((await application.archive(ADDRESS, 'barrier archive complete', 'barrier:archive-complete')).state.runtimePhase)
        .toBe('archived')
    } finally {
      await application.close()
    }
  })

  it('pauses an administrative drain when a queued Root opens a Cycle, then safely retries', async () => {
    const dir = directory('archive-queued-roots')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const application = new WorldApplication({
      worldPath: join(dir, 'world.sqlite'), sessionPath: join(dir, 'session.sqlite'), memoryPath: join(dir, 'memory.sqlite'),
      modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'root alice'), roundProvider(bob, 'root bob')],
      reactionParticipants: () => [alice, bob].map(actor => reactionBinding(actor, { calls: { value: 0 }, outputs: new Map() })),
    })
    application.activate(v5Manifest())
    try {
      const first = await application.acceptRound(ADDRESS, request('archive-queued:first'))
      const second = await application.acceptRound(ADDRESS, request('archive-queued:second'))
      await expect(application.archive(ADDRESS, 'archive after draining', 'archive-queued:attempt-one'))
        .rejects.toMatchObject({ envelope: { errorCode: 'BRANCH_DRAINING', retryable: true } })
      expect((await application.listReactionCycles(ADDRESS)).map(cycle => cycle.rootRoundId)).toEqual([first.roundId])
      await application.processReactionCycles(ADDRESS)
      await expect(application.archive(ADDRESS, 'archive after draining', 'archive-queued:attempt-two'))
        .rejects.toMatchObject({ envelope: { errorCode: 'BRANCH_DRAINING', retryable: true } })
      expect((await application.listReactionCycles(ADDRESS)).map(cycle => cycle.rootRoundId).sort())
        .toEqual([first.roundId, second.roundId].sort())
      await application.processReactionCycles(ADDRESS)
      expect((await application.archive(ADDRESS, 'archive after draining', 'archive-queued:attempt-three')).state.runtimePhase)
        .toBe('archived')
      expect((await application.listReactionCycles(ADDRESS)).every(cycle => cycle.status === 'terminal')).toBe(true)
    } finally { await application.close() }
  })

  it('stops a Cycle created by a Root which was already running when maintenance began', async () => {
    const dir = directory('maintenance-inflight-root')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const reactionCalls = { value: 0 }
    const application = new WorldApplication({
      worldPath: join(dir, 'world.sqlite'), sessionPath: join(dir, 'session.sqlite'), memoryPath: join(dir, 'memory.sqlite'),
      modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [alice, bob].map(actor => {
        const participant = roundProvider(actor, 'root speaks before maintenance')
        return { ...participant, provider: { propose: async context => {
          started.resolve()
          await finish.promise
          return participant.provider.propose(context)
        } } }
      }),
      reactionParticipants: () => [alice, bob].map(actor => reactionBinding(actor, { calls: reactionCalls, outputs: new Map() })),
    })
    application.activate(v5Manifest())
    const running = application.submit(ADDRESS, request('maintenance-inflight-root'))
      .then(result => ({ result }), error => ({ error }))
    let maintenance: Promise<unknown> | undefined
    try {
      await started.promise
      expect(await application.listReactionCycles(ADDRESS)).toEqual([])
      maintenance = application.enterMaintenance(ADDRESS, 'maintenance after root', 'maintenance:root')
      await vi.waitFor(async () => expect((await application.branchStatus(ADDRESS)).admissionState).toBe('draining'))
      finish.resolve()
      expect(await running).toHaveProperty('result')
      expect(await maintenance).toMatchObject({ state: { runtimePhase: 'maintenance' } })
      expect(await application.listReactionCycles(ADDRESS)).toEqual([
        expect.objectContaining({ status: 'terminal', terminalReason: 'administrative_stop' }),
      ])
      expect(reactionCalls.value).toBe(0)
    } finally { finish.resolve(); await running; await maintenance; await application.close() }
  })

  it.each(['maintenance', 'quarantine'] as const)('handles %s while a real Wave awaits Providers', async mode => {
    const dir = directory(`inflight-${mode}`)
    const worldPath = join(dir, 'world.sqlite')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let calls = 0
    const application = new WorldApplication({
      worldPath, sessionPath: join(dir, 'session.sqlite'), memoryPath: join(dir, 'memory.sqlite'),
      modelBudgetTokens: 64, leaseTtlMs: 30_000,
      participants: () => [roundProvider(alice, 'root alice'), roundProvider(bob, 'root bob')],
      reactionParticipants: () => [alice, bob].map(actor => ({
        ...reactionBinding(actor, { calls: { value: 0 }, outputs: new Map() }),
        provider: { propose: async context => {
          calls++
          started.resolve()
          await finish.promise
          return reactionSpeech(actor, context.origin.wave, `LATE_CANARY:${actor}`)
        } },
      })),
    })
    application.activate(v5Manifest())
    let running: Promise<unknown> | undefined
    try {
      await application.submit(ADDRESS, request(`inflight:${mode}`))
      const before = await application.head(ADDRESS)
      const cycleId = (await application.listReactionCycles(ADDRESS))[0]!.cycleId
      running = application.processReactionCycles(ADDRESS).then(result => ({ result }), error => ({ error }))
      await started.promise
      // A denied archive/fork must neither wait for nor dispose this in-flight writer.
      await expect(application.forkAtHead(ADDRESS, { ...ADDRESS, branchId: brandId('branch:inflight-child', 'BranchId') }, 'fork', 'inflight:fork'))
        .rejects.toMatchObject({ envelope: { errorCode: 'BRANCH_DRAINING', retryable: true } })
      await expect(application.archive(ADDRESS, 'archive', 'inflight:archive'))
        .rejects.toMatchObject({ envelope: { errorCode: 'BRANCH_DRAINING', retryable: true } })
      expect(application.activeBranchCount).toBe(1)
      if (mode === 'maintenance') {
        const maintenance = application.enterMaintenance(ADDRESS, 'upgrade', 'inflight:maintenance')
        await vi.waitFor(async () => {
          expect((await application.reactionCycle(ADDRESS, cycleId))?.status).toBe('stop_requested')
        })
        finish.resolve()
        expect(await running).toHaveProperty('result')
        expect((await maintenance).state.runtimePhase).toBe('maintenance')
        expect((await application.reactionCycle(ADDRESS, cycleId))?.terminalReason).toBe('administrative_stop')
        await application.exitMaintenance(ADDRESS, 'done', 'inflight:exit')
        expect((await application.eventHistory(ADDRESS)).filter(event => event.eventType === 'character.speak'
          && JSON.stringify(event.data).includes('LATE_CANARY'))).toHaveLength(2)
      } else {
        const quarantine = new BranchQuarantineService(worldPath)
        try {
          expect(quarantine.quarantine({ address: ADDRESS, source: 'inflight:test', error: createErrorEnvelope({
            errorCode: 'BUNDLE_HASH_MISMATCH', category: 'integrity', retryable: false,
            message: 'isolating while Providers await', correlationId: 'inflight:quarantine', address: ADDRESS,
          }) }).quarantinedCycleId).toBe(cycleId)
        } finally { quarantine.close() }
        finish.resolve()
        expect(await running).toHaveProperty('error')
        const probe = new WorldStore(worldPath)
        try {
          expect(probe.head(ADDRESS)).toEqual(before)
          expect(probe.readEvents(ADDRESS).some(event => JSON.stringify(event.data).includes('LATE_CANARY'))).toBe(false)
          expect(probe.verifyBranchIntegrity(ADDRESS).tick).toBe(before.tick)
        } finally { probe.close() }
        new WorldLogicalTransferService(worldPath).exportAuthority(join(dir, 'quarantined.json'), 'quarantine:export')
        await application.quarantineRecover(ADDRESS, 'inflight:recover')
        expect((await application.branchStatus(ADDRESS)).runtimePhase).toBe('active')
      }
      expect(calls).toBe(2)
      expect((await application.processReactionCycles(ADDRESS))?.waves).toHaveLength(0)
      expect(calls).toBe(2)
    } finally {
      finish.resolve()
      await running
      await application.close()
    }
  })
})
