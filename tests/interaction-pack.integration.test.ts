import { cp, mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { currentCharacterRelations } from '@harness-world/kernel'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { WorldStore } from '@harness-world/store-sqlite'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@harness-world/world-pack'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'

const packDirectory = fileURLToPath(new URL('../examples/world-packs/hand-in-hand/', import.meta.url))
const packages = [interactionPackageDescription(createBasicInteractionPackage())]

const runtimeOptions = () => ({
  address: {
    tenantId: 'tenant:hand-in-hand' as never, worldId: 'world:hand-in-hand' as never, branchId: 'branch:main' as never,
  },
  principalId: 'principal:player',
  sessionId: 'session:hand-in-hand' as never,
})

/** One player interaction in the frozen request shape the world's own selection defines. */
const interact = (bindingId: string, targetRef: WorldJsonObject, definitionId: string, args: WorldJsonObject = {}) => ({
  actionType: 'interact',
  parameters: { targetRef, bindingId, definitionRef: { id: definitionId, version: 1 }, arguments: args },
})

describe('an independent pack on the interaction path', () => {
  it('compiles, binds to v10, and plays its own selection end to end', async () => {
    const pack = await compileWorldPackSource(packDirectory, packages) as CompiledWorldPackV5
    expect(pack.compiledSchemaVersion).toBe('worldpack/v5')
    expect(pack.interactions.packages.map(entry => `${entry.ref.id}@${entry.ref.version}`))
      .toEqual(['package:interactions-basic@1'])
    // The release names the class the holding establishes, so it is reachable without ever naming an
    // instance, which is what makes the fifth definition authorable at all (ADR-0095).
    expect(pack.interactions.bindings.find(entry => entry.bindingId === 'binding:release')!.targetRef)
      .toEqual({ kind: 'relation', id: 'base:hold-hand' })
    const compiled = adaptCompiledWorldPack(pack, runtimeOptions())
    expect(compiled.manifest.schemaVersion).toBe(10)

    const root = mkdtempSync(join(tmpdir(), 'hand-in-hand-'))
    const worldPath = join(root, 'world.sqlite')
    const app = new WorldApplication({
      worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 20,
    })
    let relationId = ''
    try {
      app.activate(compiled)
      const submit = (idempotencyKey: string, action: { readonly actionType: string; readonly parameters: WorldJsonObject }) =>
        app.submit(compiled.manifest.address, {
        idempotencyKey, principalId: 'principal:player', correlationId: `hand-in-hand:${idempotencyKey}`, action,
      })
      // The bundle of the world's own content: taking it, then handing it to the companion.
      await submit('take', interact('binding:umbrella-take', { kind: 'entity', id: 'entity:shared-umbrella' }, 'base:take'))
      await submit('give', interact('binding:umbrella-give', { kind: 'entity', id: 'entity:shared-umbrella' }, 'base:give',
        { recipientId: 'character:companion' }))
      // Holding a hand, which is the one interaction here that leaves a durable relation behind.
      await submit('hold', interact('binding:companion-hold', { kind: 'character', id: 'character:companion' }, 'base:hold-hand'))
      const afterHold = new WorldStore(worldPath)
      try {
        const relations = currentCharacterRelations(afterHold.readEvents(compiled.manifest.address))
        expect(relations).toHaveLength(1)
        expect(relations[0]!.active).toBe(true)
        relationId = relations[0]!.relationId
      } finally { afterHold.close() }
      // Walking away is not an interaction, so the world fold is what ends the contact.
      await submit('move', { actionType: 'move', parameters: { locationId: 'location:ridge-path' } })
    } finally { await app.close() }
    try {
      const store = new WorldStore(worldPath)
      const events = store.readEvents(compiled.manifest.address)
      store.close()
      // The transfer landed on the companion, not on the location.
      const transferred = events.filter(event => event.eventType === 'entity.transferred')
      expect(transferred.at(-1)!.data).toMatchObject({ characterId: 'character:player', toHolderId: 'character:companion' })
      // Exactly one ending, from the fold, with the reason a move is expected to give.
      const endings = events.filter(event => event.eventType === 'character.relation-ended')
      expect(endings).toHaveLength(1)
      expect(endings[0]!.data).toEqual({
        relationId, endedByCharacterId: 'character:player', reason: 'participant_moved',
      })
      expect(currentCharacterRelations(events).filter(relation => relation.active)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)

  it('cannot yet open a Reaction Cycle on a v10 world, which is a known gap', async () => {
    // Pinned deliberately: a cycle declares which action versions it may carry, and that declaration
    // still speaks the v9 vocabulary, so a responsive v10 world refuses to open one. Whoever closes
    // this gap will have to change this expectation on purpose.
    const scratch = await mkdtemp(join(tmpdir(), 'hand-in-hand-responsive-'))
    const root = mkdtempSync(join(tmpdir(), 'hand-in-hand-reaction-'))
    try {
      await cp(packDirectory, scratch, { recursive: true })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(scratch, 'reaction.json'),
        JSON.stringify({ schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'responsive/v1' }, null, 2))
      const compiled = adaptCompiledWorldPack(
        await compileWorldPackSource(scratch, packages) as CompiledWorldPackV5, runtimeOptions())
      expect(compiled.manifest.schemaVersion).toBe(10)
      const app = new WorldApplication({
        worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'),
        memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
        reactionParticipants: () => [{
          participantId: 'agent:companion', role: 'agent', actorId: 'character:companion' as never,
          allowedActionTypes: ['speak', 'move'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
          provider: { propose: async () => ({ schemaVersion: 5, decision: 'abstain', actions: [] }) },
        }],
      })
      try {
        app.activate(compiled)
        await expect(app.submit(compiled.manifest.address, {
          idempotencyKey: 'reaction-gap', principalId: 'principal:player', correlationId: 'hand-in-hand:reaction-gap',
          action: { actionType: 'speak', parameters: { text: '雨小了。' } },
        })).rejects.toThrow(/interaction capability does not match Manifest/u)
      } finally { await app.close() }
    } finally {
      rmSync(root, { recursive: true, force: true })
      await rm(scratch, { recursive: true, force: true })
    }
  }, 60_000)

  it('takes a new interaction from the content file alone, with no code change', async () => {
    const before = await compileWorldPackSource(packDirectory, packages) as CompiledWorldPackV5
    // A copy of the same pack whose entity file declares one more binding. Nothing else differs, so a
    // catalog that moves can only have moved because the author said so.
    const scratch = await mkdtemp(join(tmpdir(), 'hand-in-hand-content-'))
    try {
      await cp(packDirectory, scratch, { recursive: true })
      const original = JSON.parse(await (await import('node:fs/promises')).readFile(join(scratch, 'entities.json'), 'utf8'))
      original.entities[1].interactionBindings.push(
        { bindingId: 'binding:thermos-drop', definition: { id: 'base:drop', version: 1 }, config: {} },
        { bindingId: 'binding:thermos-give', definition: { id: 'base:give', version: 1 }, config: {} },
      )
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(scratch, 'entities.json'), JSON.stringify(original, null, 2))
      const after = await compileWorldPackSource(scratch, packages) as CompiledWorldPackV5
      expect(before.interactions.bindings.map(entry => entry.bindingId))
        .not.toEqual(after.interactions.bindings.map(entry => entry.bindingId))
      expect(after.interactions.bindings.filter(entry => entry.targetRef.id === 'entity:thermos'))
        .toHaveLength(3)
      // Both are still v10 worlds: adding a content binding did not need a new protocol or a new verb.
      expect(adaptCompiledWorldPack(after, runtimeOptions()).manifest.schemaVersion).toBe(10)
    } finally { await rm(scratch, { recursive: true, force: true }) }
  }, 60_000)
})
