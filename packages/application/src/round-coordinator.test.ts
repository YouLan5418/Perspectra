import { FrozenInteractionRulebook, WorldBootstrap, createCoreRulebookRegistry } from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, RoundInbox, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { basicInteractionPackage, frozenInteractionWorld } from '../../../tests/fixtures/frozen-interaction-world.ts'
import { RoundCoordinator, parsePlayerRoundResult, type RoundExecutionLane } from './round-coordinator.ts'

it('commits a player action in a world with no NPC bindings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-responsive-no-bindings-'))
  const path = join(directory, 'world.sqlite')
  const world = frozenInteractionWorld('responsive/v1')
  const store = new WorldStore(path)
  const inbox = new RoundInbox(path)
  const leases = new WriterLeaseService(path)
  const availability = new CharacterRuntimeAvailabilityService(path)
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
      store, inbox, leases, availability, runtimeLane,
      ownerId: 'coordinator:no-bindings',
      rulebooks: createCoreRulebookRegistry({ interactionPackages: [basicInteractionPackage] }),
    })
    await expect(coordinator.submit({
      idempotencyKey: 'responsive:no-bindings',
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text: 'no bindings' } },
      correlationId: 'responsive:no-bindings',
    })).resolves.toMatchObject({ status: 'accepted' })
  } finally {
    coordinator?.close()
    availability.close()
    leases.close()
    inbox.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('strictly parses durable completed Round results', () => {
  const valid = {
    status: 'accepted',
    reason: null,
    headSeq: 1,
    tick: 1,
    bundleHash: `sha256:${'a'.repeat(64)}`,
  } as const
  expect(parsePlayerRoundResult(valid)).toEqual(valid)
  for (const invalid of [
    null,
    [],
    'result',
    { ...valid, extra: true },
    { ...valid, status: 'committed' },
    { ...valid, reason: 1 },
    { ...valid, headSeq: 1.5 },
    { ...valid, headSeq: -1 },
    { ...valid, tick: 1.5 },
    { ...valid, tick: -1 },
    { ...valid, bundleHash: null },
    { ...valid, bundleHash: 'sha256:short' },
  ]) expect(() => parsePlayerRoundResult(invalid as never)).toThrow(TypeError)
})
