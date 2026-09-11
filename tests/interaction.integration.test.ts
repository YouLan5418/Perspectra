import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, createStepManifestationSchema, hashWorldJson } from '@harness-world/contracts'
import { currentEntityState } from '@harness-world/kernel'
import { WorldLogicalTransferService, WorldStore } from '@harness-world/store-sqlite'
import { interactionOutput, interactionWorld } from './fixtures/interaction-world.ts'

it('runs v5 Root and Reaction interactions with durable Context, ownership, retry and logical recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'interaction-integration-'))
  const worldPath = join(root, 'world.sqlite')
  const base = interactionWorld(true)
  // A same-location manual character outside the Scene must not become a give option.
  const hidden = { ...base.manifest.characters.find(value => value.characterId === 'character:player')!, characterId: brandId('character:hidden', 'CharacterId'), name: 'Hidden' }
  const manifest = { ...base.manifest, characters: [...base.manifest.characters, hidden] }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = [...base.genesisEvents.map(event => event.eventType === 'world.manifest-locked'
    ? { ...event, data: { manifestHash, genesisPlanHash: manifest.genesisPlanHash } } : event),
  { eventType: 'character.created', eventVersion: 1, data: hidden }]
  const compiled = { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
  let rootCalls = 0
  let reactionCalls = 0
  const abstain = { schemaVersion: 5 as const, decision: 'abstain' as const, actions: [] }
  const binding = (actor: string) => ({ participantId: `agent:${actor}`, role: 'agent' as const, actorId: brandId(`character:${actor}`, 'CharacterId'),
    allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000 })
  const app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    participants: () => [{ ...binding('npc'), provider: { propose: async context => {
      expect(context).toMatchObject({ exactProviderRequest: { tools: { actionGroup: { manifestation: { schemasByAction: {
        speak: createStepManifestationSchema('speak'), move: createStepManifestationSchema('move'), interact: createStepManifestationSchema('interact'),
      } } } } } })
      const request = JSON.stringify(context)
      expect(request).toContain('submit_actions/v5')
      expect(request).toContain('core:')
      expect(request).not.toContain('character:hidden')
      expect(request).not.toContain('submit_actions/v2')
      rootCalls++
      return rootCalls === 1 ? interactionOutput() : rootCalls === 2 ? interactionOutput('give', 'character:npc', 'entity:cup', { recipientId: 'character:player' }) : abstain
    } } }],
    reactionParticipants: () => [{ ...binding('bob'), provider: { propose: async context => {
      expect(context).toMatchObject({ exactProviderRequest: { tools: { maximumReflectionOperations: 0, actionGroup: { manifestation: { schemasByAction: {
        speak: createStepManifestationSchema('speak'), move: createStepManifestationSchema('move'), interact: createStepManifestationSchema('interact'),
      } } } } } })
      expect(JSON.stringify(context)).toContain('submit_actions/v5')
      expect(JSON.stringify(context)).not.toContain('submit_actions/v2')
      reactionCalls++
      return reactionCalls === 1 ? interactionOutput('take', 'character:bob', 'entity:other') : abstain
    } } }, { ...binding('npc'), provider: { propose: async () => abstain } }],
  })
  try {
    app.activate(compiled)
    const request = { idempotencyKey: 'first', principalId: 'principal:player', action: { actionType: 'speak', parameters: { text: 'go' } }, correlationId: 'interaction' }
    await app.submit(compiled.manifest.address, request)
    await app.submit(compiled.manifest.address, request)
    expect(rootCalls).toBe(1)
    await app.processReactionCycles(compiled.manifest.address)
    await app.submit(compiled.manifest.address, { ...request, idempotencyKey: 'give' })
    await app.processReactionCycles(compiled.manifest.address)
    await app.submit(compiled.manifest.address, { ...request, idempotencyKey: 'drop', action: { actionType: 'interact', parameters: { targetId: 'entity:cup', interactionId: 'core:drop', arguments: {} } } })
    await app.processReactionCycles(compiled.manifest.address)
  } finally { await app.close() }
  try {
    const source = new WorldStore(worldPath)
    const events = source.readEvents(compiled.manifest.address)
    expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(4)
    const transfers = events.filter(event => event.eventType === 'observation.upsert').map(event => (event.data as any).value.content?.interaction).filter(Boolean)
    expect(transfers).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: 'entity:cup', toHolderId: 'character:player' }),
      expect.objectContaining({ entityId: 'entity:other', toHolderId: 'character:bob' }),
    ]))
    expect(currentEntityState(events, 'entity:cup')).toMatchObject({ holderId: null, locationId: 'location:room' })
    expect(currentEntityState(events, 'entity:other')?.holderId).toBe('character:bob')
    const head = source.head(compiled.manifest.address)
    source.close()
    const transfer = new WorldLogicalTransferService(worldPath)
    const file = join(root, 'world.dshworld')
    transfer.exportAuthority(file, 'interaction:export')
    const importedPath = join(root, 'imported.sqlite')
    transfer.importAuthority(file, importedPath, 'interaction:import')
    const imported = new WorldStore(importedPath)
    expect(imported.head(compiled.manifest.address)).toEqual(head)
    expect(imported.readEvents(compiled.manifest.address)).toEqual(events)
    imported.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
