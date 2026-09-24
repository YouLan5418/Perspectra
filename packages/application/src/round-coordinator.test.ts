import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ProviderCallStore, ProviderQualityStore } from '@harness-world/agents'
import { FrozenInteractionRulebook, WorldBootstrap, createCoreRulebookRegistry, type RoundExecutionLane } from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, RoundInbox, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { basicInteractionPackage, frozenInteractionWorld } from '../../../tests/fixtures/frozen-interaction-world.ts'
import { RoundCoordinator } from './round-coordinator.ts'

it('does not synthesize a Cycle when a responsive coordinator has no Reaction bindings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-responsive-no-bindings-'))
  const path = join(directory, 'world.sqlite')
  const world = frozenInteractionWorld('responsive/v1')
  const store = new WorldStore(path)
  const inbox = new RoundInbox(path)
  const leases = new WriterLeaseService(path)
  const availability = new CharacterRuntimeAvailabilityService(path)
  const providerCalls = new ProviderCallStore(path + '.context.sqlite')
  const providerQuality = new ProviderQualityStore(path + '.context.sqlite')
  let coordinator: RoundCoordinator | undefined
  try {
    new WorldBootstrap(store, false, new FrozenInteractionRulebook([basicInteractionPackage])).activate(world)
    availability.initialize(world.manifest.address, world.manifest.characters.map(character => ({
      characterId: character.characterId, state: 'ready',
    })))
    const runtimeLane: RoundExecutionLane = {
      address: world.manifest.address,
      manifestHash: world.manifestHash,
      enqueueRound<T>(work: () => Promise<T>): Promise<T> { return Promise.resolve().then(work) },
    }
    coordinator = new RoundCoordinator({
      store, inbox, leases, availability, providerCalls, providerQuality, runtimeLane,
      ownerId: 'coordinator:no-bindings',
      participants: [],
      modelBudgetTokens: 100,
      rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
    })
    await expect(coordinator.submit({
      idempotencyKey: 'responsive:no-bindings',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'no bindings' } },
      correlationId: 'responsive:no-bindings',
    })).resolves.toMatchObject({ status: 'accepted' })
    expect(store.activeReactionCycle(world.manifest.address)).toBeUndefined()
  } finally {
    coordinator?.close()
    providerCalls.close()
    providerQuality.close()
    availability.close()
    leases.close()
    inbox.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})