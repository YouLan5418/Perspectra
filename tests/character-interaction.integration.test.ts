import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId } from '@harness-world/contracts'
import { currentCharacterRelations } from '@harness-world/kernel'
import { WorldStore, WorldLogicalTransferService } from '@harness-world/store-sqlite'
import { characterInteractionWorld } from './fixtures/character-interaction-world.ts'

it.each(['abstain', 'failure'] as const)('commits player hold despite NPC %s, then releases and round-trips authority', async outcome => {
  const root = mkdtempSync(join(tmpdir(), 'character-interaction-'))
  const worldPath = join(root, 'world.sqlite')
  const compiled = characterInteractionWorld()
  let relationId = ''
  let calls = 0
  const app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    participants: () => [{ participantId: 'agent:npc', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async () => {
        calls++
        if (calls === 1) {
          if (outcome === 'failure') throw new Error('fixture provider unavailable')
          return { schemaVersion: 5, decision: 'abstain', actions: [] }
        }
        return { schemaVersion: 5, decision: 'act', actions: [{ actionId: 'action:npc-release', actorId: 'character:npc',
          actionType: 'interact', actionVersion: 1, parameters: { targetId: relationId, interactionId: 'core:release-hand', arguments: {} } }] }
      } } }],
  })
  try {
    app.activate(compiled)
    const request = { idempotencyKey: 'hold', principalId: 'principal:player', correlationId: 'character-test',
      action: { actionType: 'interact', parameters: { targetId: 'character:npc', interactionId: 'core:hold-hand', arguments: {} } } }
    await app.submit(compiled.manifest.address, request)
    await app.submit(compiled.manifest.address, request)
    const store = new WorldStore(worldPath)
    try {
      const relations = currentCharacterRelations(store.readEvents(compiled.manifest.address))
      expect(relations).toHaveLength(1)
      expect(relations[0]?.active).toBe(true)
      relationId = relations[0]!.relationId
    } finally { store.close() }
    await app.submit(compiled.manifest.address, { ...request, idempotencyKey: 'next', action: outcome === 'failure'
      ? { actionType: 'interact', parameters: { targetId: relationId, interactionId: 'core:release-hand', arguments: {} } }
      : { actionType: 'speak', parameters: { text: 'next' } } })
  } finally { await app.close() }
  try {
    const store = new WorldStore(worldPath)
    const events = store.readEvents(compiled.manifest.address)
    store.close()
    expect(currentCharacterRelations(events)[0]?.active).toBe(false)
    const action = events.find(event => event.eventType === 'action.resolved')!
    const authorityStore = new WorldStore(worldPath)
    const authority = authorityStore.readRoundAuthority(compiled.manifest.address, action.transactionId)!
    authorityStore.close()
    // A v9 round keeps Authority 5 and carries no frozen trace: the new binding is v10's alone.
    expect((authority.authority.resolutions as readonly Record<string, unknown>[])
      .every(entry => entry.interaction === undefined)).toBe(true)
    expect(authority.authority).toMatchObject({ schemaVersion: 5, actions: [expect.objectContaining({
      sourceRole: 'player', resolutionAuthority: { version: 'resolution-authority/v1', sourceRole: 'player', adjudicationMode: 'manual_player_immediate' },
    })] })
    const transfer = new WorldLogicalTransferService(worldPath)
    const file = join(root, 'world.dshworld')
    transfer.exportAuthority(file, 'character:export')
    const importedPath = join(root, 'imported.sqlite')
    transfer.importAuthority(file, importedPath, 'character:import')
    const imported = new WorldStore(importedPath)
    try { expect(imported.readEvents(compiled.manifest.address)).toEqual(events) } finally { imported.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('lets a later Reaction wave release a committed relation with standard authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'character-reaction-'))
  const worldPath = join(root, 'world.sqlite')
  const compiled = characterInteractionWorld(true)
  const app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
    reactionParticipants: () => [{ participantId: 'agent:npc', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async () => {
        const store = new WorldStore(worldPath)
        let relationId: string
        try { relationId = currentCharacterRelations(store.readEvents(compiled.manifest.address))[0]!.relationId } finally { store.close() }
        return { schemaVersion: 5, decision: 'act', actions: [{ actionId: 'action:reaction-release', actorId: 'character:npc',
          actionType: 'interact', actionVersion: 1, parameters: { targetId: relationId, interactionId: 'core:release-hand', arguments: {} } }] }
      } } }, { participantId: 'agent:bob', role: 'agent', actorId: brandId('character:bob', 'CharacterId'),
        allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
        provider: { propose: async () => ({ schemaVersion: 5, decision: 'abstain', actions: [] }) } }],
  })
  try {
    app.activate(compiled)
    await app.submit(compiled.manifest.address, { idempotencyKey: 'hold', principalId: 'principal:player', correlationId: 'reaction-hold',
      action: { actionType: 'interact', parameters: { targetId: 'character:npc', interactionId: 'core:hold-hand', arguments: {} } } })
    await app.processReactionCycles(compiled.manifest.address)
    const store = new WorldStore(worldPath)
    try {
      const events = store.readEvents(compiled.manifest.address)
      expect(currentCharacterRelations(events)[0]?.active).toBe(false)
      const observed = events.filter(event => event.eventType === 'observation.upsert').map(event => (event.data as any).value.content?.relations).filter(Boolean)
      expect(observed.flat()).toContainEqual({ relationKind: 'hand_hold', initiatorId: 'character:player', targetId: 'character:npc', status: 'ended', reason: 'released' })
      expect(JSON.stringify(observed)).not.toContain('relationId')
    } finally { store.close() }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

it('keeps relation state stable across restart, snapshot replay, full replay and fork-as-of', async () => {
  const root = mkdtempSync(join(tmpdir(), 'character-recovery-matrix-'))
  const worldPath = join(root, 'world.sqlite')
  const sessionPath = join(root, 'session.sqlite')
  const memoryPath = join(root, 'memory.sqlite')
  const snapshotPath = join(root, 'snapshots.sqlite')
  const compiled = characterInteractionWorld()
  const parent = compiled.manifest.address
  const creator = new WorldApplication({ worldPath, sessionPath, memoryPath, modelBudgetTokens: 20 })
  creator.activate(compiled)
  const hold = await creator.submit(parent, { idempotencyKey: 'matrix-hold', principalId: 'principal:player', correlationId: 'matrix-hold',
    action: { actionType: 'interact', parameters: { targetId: 'character:npc', interactionId: 'core:hold-hand', arguments: {} } } })
  const snapshot = await creator.createSnapshot(parent, snapshotPath, 'matrix:snapshot')
  await creator.close()

  const source = new WorldStore(worldPath)
  const started = source.readEvents(parent).find(event => event.eventType === 'character.relation-started')!
  const commit = source.committedRound(parent, started.transactionId)!
  const before = { ...parent, branchId: brandId('branch:before-relation', 'BranchId') }
  const after = { ...parent, branchId: brandId('branch:after-relation', 'BranchId') }
  source.forkBranch(parent, before, commit.baseHeadSeq)
  source.forkBranch(parent, after, hold.headSeq)
  expect(currentCharacterRelations(source.readEvents(before))).toEqual([])
  expect(currentCharacterRelations(source.readEvents(after))).toMatchObject([{ active: true }])
  expect(source.readRoundAuthority(after, started.transactionId)?.authorityHash)
    .toBe(source.readRoundAuthority(parent, started.transactionId)?.authorityHash)
  source.close()

  const restarted = new WorldApplication({ worldPath, sessionPath, memoryPath, modelBudgetTokens: 20 })
  try {
    await restarted.submit(parent, { idempotencyKey: 'matrix-release', principalId: 'principal:player', correlationId: 'matrix-release',
      action: { actionType: 'interact', parameters: { targetId: (started.data as any).relationId,
        interactionId: 'core:release-hand', arguments: {} } } })
    const replay = new WorldStore(worldPath)
    try {
      expect(currentCharacterRelations(replay.readEvents(parent))).toMatchObject([{ active: false }])
      expect(currentCharacterRelations(replay.readEvents(after))).toMatchObject([{ active: true }])
      expect(currentCharacterRelations(replay.readEvents(before))).toEqual([])
    } finally { replay.close() }
    const restoredSnapshot = restarted.latestSnapshot(parent, snapshotPath)!
    expect(restoredSnapshot).toEqual(snapshot.bundle)
    expect(JSON.stringify(restoredSnapshot.units)).toContain('"status":"started"')
    expect(JSON.stringify(restoredSnapshot.units)).not.toContain('"status":"ended"')
  } finally { await restarted.close(); rmSync(root, { recursive: true, force: true }) }
})
