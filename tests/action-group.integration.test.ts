import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, createStepManifestationSchema } from '@harness-world/contracts'
import { WorldLogicalTransferService, WorldStore } from '@harness-world/store-sqlite'
import { actionGroupWorld, groupOutput } from './fixtures/action-group-world.ts'

it('runs grouped Root and Reaction calls through real Context/Memory, and round-trips the v7 authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'group-integration-'))
  const worldPath = join(root, 'world.sqlite')
  const compiled = actionGroupWorld(true)
  let reactionCalls = 0
  const app = new WorldApplication({ worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
    modelBudgetTokens: 20,
    participants: () => [{ participantId: 'agent:group', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
      allowedActionTypes: ['speak', 'move'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async context => {
        expect(context).toMatchObject({ exactProviderRequest: { tools: { actionGroup: { manifestation: { schemasByAction: {
          speak: createStepManifestationSchema('speak'), move: createStepManifestationSchema('move'), take: createStepManifestationSchema('take'),
        } } } } } })
        return groupOutput
      } } }],
    reactionParticipants: () => [{ participantId: 'agent:bob', role: 'agent', actorId: brandId('character:bob', 'CharacterId'),
      allowedActionTypes: ['speak', 'move'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
      provider: { propose: async () => { reactionCalls++; return { schemaVersion: 4, decision: 'act', actions: [{ actionId: 'bob:speak', actorId: 'character:bob', actionType: 'speak', actionVersion: 1, parameters: { text: 'he left' } }] } } } },
      { participantId: 'agent:group', role: 'agent', actorId: brandId('character:npc', 'CharacterId'),
        allowedActionTypes: ['speak', 'move'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
        provider: { propose: async () => ({ schemaVersion: 4, decision: 'abstain', actions: [] }) } },
    ],
  })
  try {
    app.activate(compiled)
    const request = { idempotencyKey: 'group', principalId: 'principal:player', action: { actionType: 'speak', parameters: { text: 'go' } }, correlationId: 'group' }
    await expect(app.submit(compiled.manifest.address, { ...request,
      manifestation: { cues: [{ cueId: 'x', channel: 'facial', description: 'invalid legacy', persistence: 'event_only' }] },
    })).rejects.toThrow('legacy free-text')
    await app.submit(compiled.manifest.address, request)
    await app.processReactionCycles(compiled.manifest.address)
    expect(reactionCalls).toBe(1)
  } finally { await app.close() }
  try {
    const source = new WorldStore(worldPath)
    const events = source.readEvents(compiled.manifest.address)
    const observations = events.filter(e => e.eventType === 'observation.upsert').map(e => (e.data as any).value)
    expect(observations.filter(o => o.actionId === 'a:speak').map(o => o.observerId)).toEqual(['character:npc'])
    expect(observations.some(o => o.observerId === 'character:bob' && o.actionId === 'z:move')).toBe(true)
    const originalHead = source.head(compiled.manifest.address)
    source.close()
    const transfer = new WorldLogicalTransferService(worldPath)
    const file = join(root, 'world.dshworld')
    transfer.exportAuthority(file, 'group:export')
    const importedPath = join(root, 'imported.sqlite')
    transfer.importAuthority(file, importedPath, 'group:import')
    const imported = new WorldStore(importedPath)
    expect(imported.head(compiled.manifest.address)).toEqual(originalHead)
    expect(imported.readEvents(compiled.manifest.address)).toEqual(events)
    imported.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
