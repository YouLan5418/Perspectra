import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { ContextReceiptStore } from '@harness-world/agents'
import { brandId, hashWorldJson } from '@harness-world/contracts'
import { currentCharacterRelations, createCoreRulebookRegistry, RulebookRegistry } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { characterInteractionWorld } from './fixtures/character-interaction-world.ts'

it.each(['release', 'move', 'speak', 'abstain'] as const)('gives the target S1 before same-round %s and commits the bound player prefix', async response => {
  const root = mkdtempSync(join(tmpdir(), 'player-provisional-'))
  const worldPath = join(root, 'world.sqlite')
  const compiled = characterInteractionWorld()
  let called = false
  let receiptId = ''
  const app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    participants: () => [{ participantId: 'agent:npc', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async context => {
        called = true
        receiptId = (context as any).contextReceiptId
        const store = new WorldStore(worldPath)
        try { expect(currentCharacterRelations(store.readEvents(compiled.manifest.address))).toEqual([]) } finally { store.close() }
        const rendered = JSON.stringify((context as any).exactProviderRequest)
        expect(rendered).toContain('provisionalResolutionHash')
        expect(rendered).toContain('core:release-hand')
        expect(rendered).toContain('started')
        const relationId = rendered.match(/relation:[a-z0-9]+/)![0]
        if (response === 'abstain') return { schemaVersion: 5, decision: 'abstain', actions: [] }
        return { schemaVersion: 5, decision: 'act', actions: [{ actionId: 'action:s1-response', actorId: 'character:npc', actionVersion: 1,
          ...(response === 'release' ? { actionType: 'interact', parameters: { targetId: relationId, interactionId: 'core:release-hand', arguments: {} } }
            : response === 'move' ? { actionType: 'move', parameters: { locationId: 'location:next' } }
            : { actionType: 'speak', parameters: { text: 'I noticed.' } }),
        }] }
      } } }],
  })
  try {
    app.activate(compiled)
    await app.submit(compiled.manifest.address, { idempotencyKey: 'hold', principalId: 'principal:player', correlationId: 's1',
      action: { actionType: 'interact', parameters: { targetId: 'character:npc', interactionId: 'core:hold-hand', arguments: {} } } })
    expect(called).toBe(true)
    const store = new WorldStore(worldPath)
    try {
      const events = store.readEvents(compiled.manifest.address)
      const relationEvents = events.filter(event => event.eventType.startsWith('character.relation-'))
      expect(relationEvents.map(event => event.eventType)).toEqual(response === 'move' || response === 'release'
        ? ['character.relation-started', 'character.relation-ended'] : ['character.relation-started'])
      expect(new Set(relationEvents.map(event => event.transactionId)).size).toBe(1)
      const authority = store.readRoundAuthority(compiled.manifest.address, relationEvents[0]!.transactionId)!
      expect(authority.authority).toMatchObject({ schemaVersion: 5, playerProvisional: { binding: { version: 'player-provisional-resolution/v1', events: [{ draftOrdinal: 0 }] } } })
      const receipts = new ContextReceiptStore(join(root, 'memory.sqlite.context.sqlite'))
      try {
        const receipt = receipts.read(receiptId)!
        expect(receipt.includedSourceRefs).toContainEqual(expect.objectContaining({ sourceKind: 'round_stimulus',
          sourceId: 'player-provisional-resolution', sourceHash: (authority.authority as any).playerProvisional.hash }))
        expect(receipt.includedSourceRefs).toContainEqual(expect.objectContaining({ sourceId: 'player-provisional-view' }))
        expect(receipt.componentHashes.affordanceHash).toMatch(/^sha256:/)
        expect(receipt.asOfWorldSeq).toBe((authority.authority as any).baseHeadSeq)
      } finally { receipts.close() }
    } finally { store.close() }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

it('includes player move in S1 and removes the release affordance before NPC response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provisional-player-move-'))
  const compiled = characterInteractionWorld()
  const seen: string[] = []
  const app = new WorldApplication({ worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    participants: () => [{ participantId: 'agent:npc', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['interact', 'speak'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async context => { seen.push(JSON.stringify((context as any).exactProviderRequest)); return { schemaVersion: 5, decision: 'abstain', actions: [] } } },
    }],
  })
  try {
    app.activate(compiled)
    await app.submit(compiled.manifest.address, { idempotencyKey: 'hold', principalId: 'principal:player', correlationId: 'move-s1',
      action: { actionType: 'interact', parameters: { targetId: 'character:npc', interactionId: 'core:hold-hand', arguments: {} } } })
    await app.submit(compiled.manifest.address, { idempotencyKey: 'move', principalId: 'principal:player', correlationId: 'move-s1',
      action: { actionType: 'move', parameters: { locationId: 'location:next' } },
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain('core:release-hand')
    expect(seen[1]).toContain('participant_moved')
    expect(seen[1]).not.toContain('core:release-hand')
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

it('shows arrival to destination NPCs and departure to source NPCs without fabricated committed sequences', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provisional-scenes-'))
  const worldPath = join(root, 'world.sqlite')
  const base = characterInteractionWorld()
  const manifest = { ...base.manifest, characters: base.manifest.characters.map(character => character.characterId === 'character:bob'
    ? { ...character, locationId: 'location:next' } : character),
    scenes: [...base.manifest.scenes, { sceneId: 'scene:next', lifecycle: 'active' as const, locationId: 'location:next', participantIds: [brandId('character:bob', 'CharacterId')] }],
  }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = [...base.genesisEvents.map(event => {
    if (event.eventType === 'world.manifest-locked') return { ...event, data: { manifestHash, genesisPlanHash: manifest.genesisPlanHash } }
    if (event.eventType === 'scene.upsert') return { ...event, data: { sceneId: 'scene:room', value: { lifecycle: 'active', locationId: 'location:room', participantIds: ['character:player', 'character:npc'] } } }
    if (event.eventType === 'character.created' && (event.data as any).characterId === 'character:bob') return { ...event, data: { ...event.data as any, locationId: 'location:next' } }
    return event
  }), { eventType: 'scene.upsert', eventVersion: 1, data: { sceneId: 'scene:next', value: { lifecycle: 'active', locationId: 'location:next', participantIds: ['character:bob'] } } }]
  const compiled = { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
  const seen = new Map<string, string>()
  const app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    participants: () => ['bob', 'npc'].map(id => ({ participantId: `agent:${id}`, role: 'agent' as const, actorId: brandId(`character:${id}`, 'CharacterId'),
      allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async (context: any) => { seen.set(id, JSON.stringify(context.exactProviderRequest)); return { schemaVersion: 5 as const, decision: 'abstain' as const, actions: [] } } },
    })),
  })
  try {
    app.activate(compiled)
    await app.submit(manifest.address, { idempotencyKey: 'move', principalId: 'principal:player', correlationId: 'arrival',
      action: { actionType: 'move', parameters: { locationId: 'location:next' } } })
    expect([...seen.keys()].sort()).toEqual(['bob', 'npc'])
    expect(seen.get('bob')).toContain('character.moved')
    expect(seen.get('bob')).toContain('scene:next')
    const store = new WorldStore(worldPath)
    try {
      expect(store.readEvents(manifest.address).filter(event => event.eventType === 'observation.upsert')
        .map(event => (event.data as any).value.observerId)).toContain('character:bob')
    } finally { store.close() }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

it('treats competing NPC proposals as domain rejection while retaining the player effect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provisional-conflict-'))
  const worldPath = join(root, 'world.sqlite')
  const base = characterInteractionWorld()
  const catalog = base.manifest.interactionCatalog as any
  const manifest = { ...base.manifest, interactionCatalog: { ...catalog,
    definitions: [...catalog.definitions, { interactionId: 'core:take', label: 'take', targetKind: 'entity', operation: 'take', initiationPolicy: { manualPlayer: 'standard', autonomousCharacter: 'standard' } }],
    bindings: [...catalog.bindings, { targetId: 'entity:cup', interactionIds: ['core:take'] }],
  } }
  const manifestHash = hashWorldJson('compiled-world-manifest', manifest)
  const genesisEvents = base.genesisEvents.map(event => event.eventType === 'world.manifest-locked' ? { ...event, data: { manifestHash, genesisPlanHash: manifest.genesisPlanHash } } : event)
  const compiled = { manifest, manifestHash, genesisEvents, genesisHash: hashWorldJson('world-genesis-plan', genesisEvents) }
  const app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    participants: () => ['npc', 'bob'].map(id => ({ participantId: `agent:${id}`, role: 'agent' as const, actorId: brandId(`character:${id}`, 'CharacterId'),
      allowedActionTypes: ['interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async context => {
        expect(JSON.stringify((context as any).exactProviderRequest)).toContain('core:take')
        return { schemaVersion: 5 as const, decision: 'act' as const, actions: [{ actionId: `action:take:${id}`, actorId: brandId(`character:${id}`, 'CharacterId'),
          actionType: 'interact', actionVersion: 1, parameters: { targetId: 'entity:cup', interactionId: 'core:take', arguments: {} } }] }
      } },
    })),
  })
  try {
    app.activate(compiled)
    await app.submit(manifest.address, { idempotencyKey: 'hold', principalId: 'principal:player', correlationId: 'conflict',
      action: { actionType: 'interact', parameters: { targetId: 'character:npc', interactionId: 'core:hold-hand', arguments: {} } } })
    const store = new WorldStore(worldPath)
    try {
      const events = store.readEvents(manifest.address)
      expect(currentCharacterRelations(events)[0]?.active).toBe(true)
      expect(events.filter(event => event.eventType === 'entity.transferred')).toHaveLength(1)
      expect(events.filter(event => event.eventType === 'action.rejected')).toMatchObject([{ data: { reason: 'ITEM_NOT_AVAILABLE' } }])
    } finally { store.close() }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

it('does not commit a player resolution whose authoritative bytes drift after Context construction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provisional-integrity-'))
  const worldPath = join(root, 'world.sqlite')
  const compiled = characterInteractionWorld()
  const core = createCoreRulebookRegistry().resolve('builtin:speak-move', 2, 'core')
  let captured: any
  const rulebooks = new RulebookRegistry()
  rulebooks.register('builtin:speak-move', 2, { affordances: context => core.affordances(context), resolve: context => {
    const result = core.resolve(context)
    if (context.resolutionAuthority?.sourceRole === 'player') captured = result
    return result
  } })
  const app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), rulebooks, modelBudgetTokens: 20,
    participants: () => [{ participantId: 'agent:npc', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async () => { captured.events[0].data.targetId = 'character:bob'; return { schemaVersion: 5, decision: 'abstain', actions: [] } } },
    }],
  })
  try {
    app.activate(compiled)
    await expect(app.submit(compiled.manifest.address, { idempotencyKey: 'hold', principalId: 'principal:player', correlationId: 'integrity',
      action: { actionType: 'interact', parameters: { targetId: 'character:npc', interactionId: 'core:hold-hand', arguments: {} } } })).rejects.toThrow('differs from final')
    const store = new WorldStore(worldPath)
    try { expect(currentCharacterRelations(store.readEvents(compiled.manifest.address))).toEqual([]) } finally { store.close() }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

it.each(['scene_public', 'private', 'direct', 'self'] as const)('clips %s provisional speech for bystanders and Director', async scope => {
  const root = mkdtempSync(join(tmpdir(), 'provisional-visibility-'))
  const compiled = characterInteractionWorld()
  const seen = new Map<string, string>()
  const app = new WorldApplication({ worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    participants: () => [
      ...['npc', 'bob'].map(id => ({ participantId: `agent:${id}`, role: 'agent' as const, actorId: brandId(`character:${id}`, 'CharacterId'),
        allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
        provider: { propose: async (context: any) => { seen.set(id, JSON.stringify(context)); return { schemaVersion: 5 as const, decision: 'abstain' as const, actions: [] } } },
      })),
      { participantId: 'director:bob', role: 'director', actorId: brandId('character:bob', 'CharacterId'),
        allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
        provider: { propose: async context => { seen.set('director', JSON.stringify(context)); return { participantId: 'director:bob', actions: [] } } },
      },
    ],
  })
  try {
    app.activate(compiled)
    await app.submit(compiled.manifest.address, { idempotencyKey: 'speech', principalId: 'principal:player', correlationId: 'visibility',
      action: { actionType: 'speak', parameters: { text: 'unique-private-content', scope, addresseeIds: scope === 'private' || scope === 'direct' ? ['character:npc'] : [] } } })
    expect(seen.size).toBe(3)
    expect(seen.get('npc')!.includes('unique-private-content')).toBe(scope !== 'self')
    expect(seen.get('bob')!.includes('unique-private-content')).toBe(scope === 'scene_public')
    expect(seen.get('director')!.includes('unique-private-content')).toBe(scope === 'scene_public')
    if (scope === 'private') expect(seen.get('bob')).toContain('occurrence_only')
    if (scope === 'direct' || scope === 'self') expect(seen.get('bob')).toContain('none')
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})
