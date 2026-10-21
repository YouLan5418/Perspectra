import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, interactionPackageDescription, resolutionAuthority, type WorldJsonObject } from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { InteractionRegistry } from '@harness-world/interaction-runtime'
import { createCoreRulebookRegistry, currentEntityState } from '@harness-world/kernel'
import { CharacterRuntimeAvailabilityService, WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@harness-world/world-pack'
import { CharacterTurn } from '../../packages/application/src/character-turn.ts'

it('executes the exact offered definition, then publishes freely from its committed result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'perspectra-package-turn-'))
  const installed = createBasicInteractionPackage()
  const pack = await compileWorldPackSource(resolve('examples/world-packs/hand-in-hand'), [interactionPackageDescription(installed)])
  const world = adaptCompiledWorldPack(pack, { address: { tenantId: brandId('tenant:turn', 'TenantId'),
    worldId: brandId('world:turn', 'WorldId'), branchId: brandId('branch:main', 'BranchId') },
    principalId: 'principal:player', sessionId: brandId('session:turn', 'SessionId') })
  const path = join(directory, 'world.sqlite')
  const app = new WorldApplication({ worldPath: path, sessionPath: join(directory, 'session.sqlite'),
    memoryPath: join(directory, 'memory.sqlite'), interactionPackages: [installed] })
  let store: WorldStore | undefined, leases: WriterLeaseService | undefined, availability: CharacterRuntimeAvailabilityService | undefined
  try {
    app.activate(world)
    await app.submitText(world.manifest.address, { text: '请试着拿起伞，再告诉我结果。', idempotencyKey: 'invite',
      principalId: 'principal:player', correlationId: 'invite' })
    await app.release(world.manifest.address)
    store = new WorldStore(path); leases = new WriterLeaseService(path); availability = new CharacterRuntimeAvailabilityService(path)
    const npc = brandId('character:companion', 'CharacterId')
    const rules = createCoreRulebookRegistry({ interactionPackages: [installed] })
    let calls = 0
    const turn = new CharacterTurn({ address: world.manifest.address, store, leases, availability,
      rulebooks: rules, decide: async request => {
        calls++
        if (calls === 1) {
          const affordances = request.context.affordances as WorldJsonObject[]
          const choices = affordances.find(offer => offer.actionType === 'interact')!.interactions as WorldJsonObject[]
          const option = choices.find(choice => choice.bindingId === 'binding:umbrella-take')!
          expect(option.definitionRef).toEqual({ id: 'base:take', version: 1 })
          return { decision: 'perform', actionType: 'interact', parameters: {
            targetRef: option.targetRef, bindingId: option.bindingId, definitionRef: option.definitionRef, arguments: {} } }
        }
        expect(request.continuation).toBe(true)
        expect(request.result?.status).toBe('accepted')
        expect(currentEntityState(store!.readEvents(world.manifest.address), 'entity:shared-umbrella')?.holderId).toBe(npc)
        return { decision: 'publish', segments: [{ type: 'narration', text: '她笑着抬起眼。' }, { type: 'speech', text: '拿到了。' }] }
      } })
    expect(await turn.run(npc, { maxCalls: 2 })).toMatchObject({ status: 'published', calls: 2 })
    const events = store.readEvents(world.manifest.address)
    expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(1)
    expect(events.some(event => event.eventType === 'character.speak' && JSON.stringify(event.data).includes('拿到了。'))).toBe(true)
    const resolution = events.find(event => event.eventType === 'action.resolved' && (event.data as WorldJsonObject).actionType === 'interact')!
    const authority = store.readRoundAuthority(world.manifest.address, resolution.transactionId)!.authority
    expect(authority).toMatchObject({ actorId: npc, status: 'accepted', action: { actionType: 'interact',
      parameters: { bindingId: 'binding:umbrella-take', definitionRef: { id: 'base:take', version: 1 } } } })
    // Re-adjudicate the committed action at its original prefix. The current NPC path stores its
    // actual action/result, rather than manufacturing the retired batch Authority 6 envelope.
    const prefix = events.slice(0, events.findIndex(event => event.transactionId === resolution.transactionId))
    const replay = rules.resolve(world.manifest.rulebook.rulebookId, world.manifest.rulebook.version, 'replay', world.manifest.address)
      .resolve({ manifest: world.manifest, manifestHash: world.manifestHash, events: prefix,
        characterId: npc, actionId: String(authority.actionId), asOfWorldSeq: prefix.length,
        roundId: store.committedRound(world.manifest.address, resolution.transactionId)!.roundId,
        resolutionAuthority: resolutionAuthority('agent', 'standard'),
        action: authority.action as { actionType: string; parameters: WorldJsonObject } })
    expect(replay.status).toBe('accepted')
    const trace = replay.interactionTrace!
    expect(Object.keys(trace).sort()).toEqual(['definitionSetHash', 'resolvedRoleBindingsHash', 'ruleTraceHash'])
    const registry = new InteractionRegistry(); registry.install(installed)
    const frozen = registry.freeze({ address: world.manifest.address, packages: pack.interactions.packages,
      definitions: pack.interactions.definitions, bindings: pack.interactions.bindings })
    expect(trace.definitionSetHash).toBe(frozen.definitionSetHash)
    for (const value of Object.values(trace)) expect(value).toMatch(/^sha256:[0-9a-f]{64}$/u)
  } finally {
    availability?.close(); leases?.close(); store?.close(); await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
