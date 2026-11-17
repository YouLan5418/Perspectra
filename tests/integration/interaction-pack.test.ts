import { interactionPackageDescription } from '@perspectra/sdk/contracts'
import { createItemCustodyTestPackage } from '../fixtures/item-custody-package.ts'
import type { CompiledWorldPackV5 } from '@perspectra/world-pack'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@perspectra/world-pack'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packDirectory = fileURLToPath(new URL('../../examples/world-packs/hand-in-hand/', import.meta.url))
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

describe('an independent pack on the interaction path', () => {
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
      selection.packages.push({ id: 'package:interactions-basic', version: 1 })
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
