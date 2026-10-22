import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { WorldApplication } from '@harness-world/application'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { createItemCustodyTestPackage } from '../fixtures/item-custody-package.ts'
import { currentCharacterRelations } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@harness-world/world-pack'
import { mkdtempSync, rmSync } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packDirectory = fileURLToPath(new URL('../../examples/world-packs/hand-in-hand/', import.meta.url))
// The host's contact rules. Item custody is the pack's own script; the content-only test below adds bindings
// that the test-only custody package defines.
const packages = [interactionPackageDescription(createBasicInteractionPackage())]
const custodyPackages = [interactionPackageDescription(createItemCustodyTestPackage())]

const runtimeOptions = () => ({
  address: {
    tenantId: 'tenant:hand-in-hand' as never,
    worldId: 'world:hand-in-hand' as never,
    branchId: 'branch:main' as never,
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
    const pack = (await compileWorldPackSource(packDirectory, packages)) as CompiledWorldPackV5
    expect(pack.compiledSchemaVersion).toBe('worldpack/v5')
    expect(pack.interactions.packages.map(entry => `${entry.ref.id}@${entry.ref.version}`)).toEqual([
      'package:interactions-basic@1',
    ])
    // The release names the class the holding establishes, so it is reachable without ever naming an
    // instance, which is what makes the fifth definition authorable at all (ADR-0095).
    expect(pack.interactions.bindings.find(entry => entry.bindingId === 'binding:release')!.targetRef).toEqual({
      kind: 'relation',
      id: 'base:hold-hand',
    })
    const compiled = adaptCompiledWorldPack(pack, runtimeOptions())
    expect(compiled.manifest.schemaVersion).toBe(10)

    const root = mkdtempSync(join(tmpdir(), 'hand-in-hand-'))
    const worldPath = join(root, 'world.sqlite')
    const app = new WorldApplication({
      worldPath,
      sessionPath: join(root, 'session.sqlite'),
      memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 20,
    })
    let relationId = ''
    try {
      app.activate(compiled)
      const submit = (
        idempotencyKey: string,
        action: { readonly actionType: string; readonly parameters: WorldJsonObject },
      ) =>
        app.submit(compiled.manifest.address, {
          idempotencyKey,
          principalId: 'principal:player',
          correlationId: `hand-in-hand:${idempotencyKey}`,
          action,
        })
      // Holding a hand, which is the one interaction here that leaves a durable relation behind.
      await submit(
        'hold',
        interact('binding:companion-hold', { kind: 'character', id: 'character:companion' }, 'base:hold-hand'),
      )
      const afterHold = new WorldStore(worldPath)
      try {
        const relations = currentCharacterRelations(afterHold.readEvents(compiled.manifest.address))
        expect(relations).toHaveLength(1)
        expect(relations[0]!.active).toBe(true)
        relationId = relations[0]!.relationId
      } finally {
        afterHold.close()
      }
      // Walking away is not an interaction, so the world fold is what ends the contact.
      await submit('move', { actionType: 'move', parameters: { locationId: 'location:ridge-path' } })
    } finally {
      await app.close()
    }
    try {
      const store = new WorldStore(worldPath)
      const events = store.readEvents(compiled.manifest.address)
      store.close()
      // Exactly one ending, from the fold, with the reason a move is expected to give.
      const endings = events.filter(event => event.eventType === 'character.relation-ended')
      expect(endings).toHaveLength(1)
      expect(endings[0]!.data).toEqual({
        relationId,
        endedByCharacterId: 'character:player',
        reason: 'participant_moved',
      })
      expect(currentCharacterRelations(events).filter(relation => relation.active)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('takes a new interaction from the content file alone, with no code change', async () => {
    const before = (await compileWorldPackSource(packDirectory, custodyPackages)) as CompiledWorldPackV5
    // A copy of the same pack whose entity file declares one more binding. Nothing else differs, so a
    // catalog that moves can only have moved because the author said so.
    const scratch = await mkdtemp(join(tmpdir(), 'hand-in-hand-content-'))
    try {
      await cp(packDirectory, scratch, { recursive: true })
      const original = JSON.parse(
        await (await import('node:fs/promises')).readFile(join(scratch, 'entities.json'), 'utf8'),
      )
      original.entities[1].interactionBindings = [
        { bindingId: 'binding:thermos-drop', definition: { id: 'base:drop', version: 1 }, config: {} },
        { bindingId: 'binding:thermos-give', definition: { id: 'base:give', version: 1 }, config: {} },
      ]
      const { readFile, writeFile } = await import('node:fs/promises')
      await writeFile(join(scratch, 'entities.json'), JSON.stringify(original, null, 2))
      const selection = JSON.parse(await readFile(join(scratch, 'interactions.json'), 'utf8'))
      selection.definitions.push({ id: 'base:drop', version: 1 }, { id: 'base:give', version: 1 })
      await writeFile(join(scratch, 'interactions.json'), JSON.stringify(selection, null, 2))
      const after = (await compileWorldPackSource(scratch, custodyPackages)) as CompiledWorldPackV5
      expect(before.interactions.bindings.map(entry => entry.bindingId)).not.toEqual(
        after.interactions.bindings.map(entry => entry.bindingId),
      )
      expect(after.interactions.bindings.filter(entry => entry.targetRef.id === 'entity:thermos')).toHaveLength(2)
      // Both are still v10 worlds: adding a content binding did not need a new protocol or a new verb.
      expect(adaptCompiledWorldPack(after, runtimeOptions()).manifest.schemaVersion).toBe(10)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }, 60_000)
})
