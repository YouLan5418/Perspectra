import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readPackConfiguration, savePackConfiguration } from '../../desktop/pack-config.ts'
import { LauncherCore } from '../../desktop/launcher-core.ts'
import { copyRpgFixture } from '../support/rpg-fixture.ts'
import { investigationFixture } from '../support/investigation-fixture.ts'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fresh = (script = false) => {
  const f = script ? investigationFixture() : copyRpgFixture()
  roots.push(f.root)
  return f
}
it('reads config schema without opening a model and saves only validated declared config', async () => {
  const f = fresh(),
    file = join(f.pack, 'rpg.json')
  const doc = await readPackConfiguration(f.pack, [])
  expect(doc.validation).toBe('')
  expect(doc.entries).toHaveLength(1)
  const entry = doc.entries[0]!
  expect(entry.id).toBe('official-rpg')
  expect(entry.schema).toHaveProperty('properties')
  const value = JSON.parse(entry.text),
    original = readFileSync(file, 'utf8')
  value.rest.locations = ['location:missing']
  await expect(
    savePackConfiguration(f.pack, [], { id: entry.id, packHash: doc.packHash, value }, () => {}),
  ).rejects.toThrow()
  expect(readFileSync(file, 'utf8')).toBe(original)
  value.rest.locations = ['location:bedroom']
  value.characters['character:player'].attack = 7
  await savePackConfiguration(f.pack, [], { id: entry.id, packHash: doc.packHash, value }, () => {})
  expect(JSON.parse(readFileSync(file, 'utf8')).characters['character:player'].attack).toBe(7)
  await expect(
    savePackConfiguration(f.pack, [], { id: entry.id, packHash: doc.packHash, value }, () => {}),
  ).rejects.toThrow('其他编辑')
})
it('refuses undeclared configuration and checks the running guard before any file mutation', async () => {
  const f = fresh(),
    doc = await readPackConfiguration(f.pack, []),
    original = readFileSync(join(f.pack, 'rpg.json'), 'utf8')
  await expect(
    savePackConfiguration(f.pack, [], { id: '../rpg.json', packHash: doc.packHash, value: {} }, () => {}),
  ).rejects.toThrow('不属于')
  const input = { id: 'official-rpg', packHash: doc.packHash, value: JSON.parse(original) }
  await expect(
    savePackConfiguration(f.pack, [], input, () => {
      throw new Error('running')
    }),
  ).rejects.toThrow('running')
  expect(readFileSync(join(f.pack, 'rpg.json'), 'utf8')).toBe(original)
})
it('can repair invalid JSON using the declared schema but never persists failed validation', async () => {
  const f = fresh(),
    file = join(f.pack, 'rpg.json'),
    value = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, '{')
  const doc = await readPackConfiguration(f.pack, [])
  expect(doc.validation).not.toBe('')
  expect(doc.entries[0]!.text).toBe('{')
  await savePackConfiguration(f.pack, [], { id: 'official-rpg', packHash: doc.packHash, value }, () => {})
  expect((await readPackConfiguration(f.pack, [])).validation).toBe('')
})
it('edits inline script config through the real Launcher request and refreshes the loaded pack hash', async () => {
  const f = fresh(true),
    core = new LauncherCore(resolve('.'), join(f.root, 'launcher'))
  await core.initialize()
  await core.handle({ operation: 'load', path: f.pack })
  const packageId = core.snapshot().packs[0]!.id
  const doc = (await core.handle({ operation: 'pack-config-read', packageId })) as unknown as Awaited<
    ReturnType<typeof readPackConfiguration>
  >
  expect(doc.entries[0]).toMatchObject({ id: 'scripts/gameplay', schema: { required: ['energy'] } })
  const before = readFileSync(join(f.pack, 'worldpack.source.json'), 'utf8')
  await expect(
    core.handle({
      operation: 'pack-config-save',
      packageId,
      configId: 'scripts/gameplay',
      packHash: doc.packHash,
      value: { energy: 0 },
    }),
  ).rejects.toThrow()
  expect(readFileSync(join(f.pack, 'worldpack.source.json'), 'utf8')).toBe(before)
  await core.handle({
    operation: 'pack-config-save',
    packageId,
    configId: 'scripts/gameplay',
    packHash: doc.packHash,
    value: { energy: 5 },
  })
  const next = await readPackConfiguration(f.pack, [])
  expect(next.packHash).not.toBe(doc.packHash)
  expect(JSON.parse(next.entries[0]!.text)).toEqual({ energy: 5 })
  expect(core.snapshot().packs[0]!.hash).toBe(next.packHash)
})

it('serializes competing saves to the same source pack and releases the lock after failure', async () => {
  const f = fresh(),
    doc = await readPackConfiguration(f.pack, [])
  const first = JSON.parse(doc.entries[0]!.text),
    second = structuredClone(first)
  first.characters['character:player'].attack = 101
  second.characters['character:player'].attack = 202
  const results = await Promise.allSettled(
    [first, second].map(value =>
      savePackConfiguration(f.pack, [], { id: 'official-rpg', packHash: doc.packHash, value }, () => {}),
    ),
  )
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(f.pack, 'rpg.json'), 'utf8')).characters['character:player'].attack).toBe(101)
  expect(existsSync(join(f.pack, '.perspectra-config.lock'))).toBe(false)
  const next = await readPackConfiguration(f.pack, [])
  await expect(
    savePackConfiguration(f.pack, [], { id: 'official-rpg', packHash: next.packHash, value: {} }, () => {}),
  ).rejects.toThrow()
  expect(existsSync(join(f.pack, '.perspectra-config.lock'))).toBe(false)
})
