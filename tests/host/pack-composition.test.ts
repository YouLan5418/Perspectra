import { loadHostPlugins } from '../../apps/host/src/host-plugins.ts'
import { assembleRoleplay } from '../../apps/host/src/official-bundle.ts'
import { createRequire } from 'node:module'
import type { ContentGameplay } from '@perspectra/sdk'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  compileWorldPackSource,
  validatePackComposition,
  validatePluginConfig,
  parseWorldPackSourceManifestV5,
  type CompiledWorldPackV5,
} from '@perspectra/world-pack'
import { interactionPackageDescription } from '@perspectra/sdk/contracts'
import { defaultInteractionPackages } from '../../apps/host/src/official-bundle.ts'
import { officialPackPlugins } from '../../apps/host/src/official-pack-metadata.ts'
import { packValidationCatalog, validateInstalledPack } from '../../apps/host/src/pack-validation.ts'
import { copyRpgFixture, openRpgWorld } from '../support/rpg-fixture.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function fixture() {
  const f = copyRpgFixture()
  cleanup.push(() => rmSync(f.root, { recursive: true, force: true }))
  return f
}
function manifest(pack: string, change: (value: any) => void) {
  const file = join(pack, 'worldpack.source.json')
  const value = JSON.parse(readFileSync(file, 'utf8'))
  change(value)
  writeFileSync(file, JSON.stringify(value))
}
const compile = (pack: string) =>
  compileWorldPackSource(pack, defaultInteractionPackages().map(interactionPackageDescription))

it('treats no gameplay selection as empty even with a broken RPG config asset', async () => {
  const f = fixture()
  manifest(f.pack, value => {
    value.plugins = {}
  })
  writeFileSync(join(f.pack, 'rpg.json'), '{')
  await validateInstalledPack(f.pack, [])
  const world = await openRpgWorld(f.pack, f.data)
  cleanup.push(() => world.close())
  expect(world.events().some(event => JSON.stringify(event.data).includes('rpg-'))).toBe(false)
})

it('fails closed for absent dependencies, missing plugins, exact-version mismatches and service conflicts', async () => {
  const f = fixture()
  manifest(f.pack, value => {
    delete value.plugins['official-dice']
  })
  await expect(validateInstalledPack(f.pack, [])).rejects.toThrow('explicitly declare dependency')
  manifest(f.pack, value => {
    value.plugins = { missing: {} }
  })
  await expect(openRpgWorld(f.pack, f.data)).rejects.toThrow('missing')
  manifest(f.pack, value => {
    value.plugins = { 'official-rpg': { version: '99' }, 'official-dice': {} }
  })
  await expect(openRpgWorld(f.pack, f.data)).rejects.toThrow('required version 99')
  manifest(f.pack, value => {
    value.plugins = {}
    value.services = { scheduler: 'missing-scheduler' }
  })
  await expect(openRpgWorld(f.pack, f.data)).rejects.toThrow('/services/scheduler')
  expect(existsSync(join(f.data, 'world.sqlite'))).toBe(false)
})

it('runs pure config validators, not generators, and distinguishes invalid config from plugin bugs', async () => {
  const f = fixture(),
    pack = await compile(f.pack)
  const generate = vi.fn(() => {
    throw new Error('must not run')
  })
  const catalog = officialPackPlugins.map(plugin => (plugin.id === 'official-rpg' ? { ...plugin, generate } : plugin))
  validatePackComposition(pack, catalog, file => readFileSync(join(f.pack, file), 'utf8'))
  expect(generate).not.toHaveBeenCalled()
  const facts = { characterIds: [], locationIds: [], entityIds: [], entityLocations: {}, names: {} }
  expect(() =>
    validatePluginConfig(
      {
        id: 'faulty',
        version: '1',
        validateConfig: () => {
          throw new TypeError('private stack')
        },
      },
      {},
      facts,
    ),
  ).toThrow(expect.objectContaining({ code: 'PLUGIN_VALIDATOR_FAULT', message: 'faulty: config validator failed' }))
  expect(() =>
    validatePluginConfig(
      { id: 'rules', version: '1', validateConfig: () => [{ path: '/map', message: 'unknown location' }] },
      {},
      facts,
    ),
  ).toThrow(expect.objectContaining({ code: 'PACK_COMPOSITION_INVALID' }))
})

it('checks native permission and version before any validator module import', async () => {
  const f = fixture(),
    entry = join(f.root, 'external.mjs'),
    marker = join(f.root, 'executed')
  writeFileSync(
    entry,
    "import {writeFileSync} from 'node:fs'; writeFileSync(" +
      JSON.stringify(marker) +
      ", 'imported'); export const packPlugin={id:'external',version:'1.0.0'}",
  )
  writeFileSync(
    join(f.root, 'external.plugin.json'),
    JSON.stringify({ id: 'external', name: 'External', version: '1.0.0', services: ['content'] }),
  )
  const settings = { id: 'installed-external', path: entry, enabled: true, nativeAllowed: false }
  await expect(packValidationCatalog({ plugins: { external: {} } }, [settings])).rejects.toThrow('not allowed')
  expect(existsSync(marker)).toBe(false)
  await expect(
    packValidationCatalog({ plugins: { external: { version: '2' } } }, [{ ...settings, nativeAllowed: true }]),
  ).rejects.toThrow('version')
  expect(existsSync(marker)).toBe(false)
  await packValidationCatalog({ plugins: { external: { version: '1.0.0' } } }, [{ ...settings, nativeAllowed: true }])
  expect(existsSync(marker)).toBe(true)
})

it('rejects script/config paths outside locked asset declarations', () => {
  const value = JSON.parse(readFileSync(resolve('tests/fixtures/rpg-pack/worldpack.source.json'), 'utf8'))
  value.scripts = { gameplay: { entry: '../secret.js' } }
  expect(() => parseWorldPackSourceManifestV5(value)).toThrow('assetFiles')
})

it('opens a common script, adjudicates search, preserves private clues and reopens committed state', async () => {
  const f = fixture()
  mkdirSync(join(f.pack, 'scripts'), { recursive: true })
  writeFileSync(join(f.pack, 'scripts/gameplay.cjs'), readFileSync(resolve('examples/gameplay/investigation.cjs')))
  manifest(f.pack, value => {
    value.plugins = {}
    value.assetFiles.push('scripts/gameplay.cjs')
    value.scripts = { gameplay: { entry: 'scripts/gameplay.cjs', config: { energy: 1 } } }
  })
  await validateInstalledPack(f.pack, [])
  const compiled = (await compile(f.pack)) as CompiledWorldPackV5
  expect(compiled.scripts?.gameplay.config).toEqual({ energy: 1 })
  const world = await openRpgWorld(f.pack, f.data)
  const action = {
    actionType: 'interact' as const,
    parameters: {
      definitionRef: { id: 'investigation:search', version: 1 },
      bindingId: 'gameplay',
      targetRef: { kind: 'location', id: 'location:living-room' },
      arguments: {},
    },
  }
  try {
    await world.runtime.perform(action)
    const changes = world
      .events()
      .filter(event => event.eventType === 'status.updated')
      .flatMap(event => (event.data as any).changes ?? [])
    expect(changes).toContainEqual({ holderId: 'character:player', key: 'energy', value: 0 })
    expect(changes).toContainEqual({ holderId: 'character:player', key: 'clues', value: ['clue:letter'] })
    expect((await world.runtime.perform(action)).notice).toContain('精力不足')
  } finally {
    await world.close()
  }
  const reopened = await openRpgWorld(f.pack, f.data)
  cleanup.push(() => reopened.close())
  expect((await reopened.runtime.perform(action)).notice).toContain('精力不足')
})

it('refuses no-manifest and undeclared real gameplay registrations at the formal pack loader', async () => {
  const f = fixture(),
    path = join(f.root, 'rules.mjs')
  writeFileSync(
    path,
    "export const hostApi='2.11'; export default ctx=>{ctx.effect(()=>ctx.rules.register({id:'hidden-rules',version:'1',open:async()=>({})}))}",
  )
  const settings = [{ id: 'native', path, enabled: true, nativeAllowed: true }]
  await expect(loadHostPlugins(settings, {}, {}, { gameplayIds: [] })).rejects.toMatchObject({ reason: 'manifest' })
  writeFileSync(
    join(f.root, 'rules.plugin.json'),
    JSON.stringify({ id: 'native', name: 'Native', version: '1', services: ['memory'] }),
  )
  await expect(loadHostPlugins(settings, {}, {}, { gameplayIds: [] })).rejects.toMatchObject({ reason: 'apply' })
})

it('does not discard an explicit replacement, and resolves default LLM identity before checking requirements', async () => {
  const f = fixture()
  manifest(f.pack, value => {
    value.plugins = {}
    value.services = { communication: 'custom-communication' }
  })
  const open = vi.fn(async () => {
    throw new TypeError('selected provider failed')
  })
  await expect(
    openRpgWorld(f.pack, f.data, {
      composition: assembleRoleplay({
        communication: { id: 'custom-communication', version: '1', open },
      }),
    }),
  ).rejects.toMatchObject({ pluginId: 'custom-communication' })
  expect(open).toHaveBeenCalledOnce()
  manifest(f.pack, value => {
    value.services = { llm: 'official-llm' }
  })
  const world = await openRpgWorld(f.pack, f.data)
  cleanup.push(() => world.close())
})

it('passes native common configuration and installed identity through tail checks and reopening', async () => {
  const f = fixture()
  const definition = createRequire(import.meta.url)(resolve('examples/gameplay/investigation.cjs')) as ContentGameplay
  manifest(f.pack, value => {
    value.plugins = { 'example-investigation': { config: 'investigation.json' }, 'external-rules': {} }
    value.assetFiles.push('investigation.json')
  })
  writeFileSync(join(f.pack, 'investigation.json'), JSON.stringify({ energy: 1 }))
  const composition = assembleRoleplay({
    content: [
      {
        id: 'example-investigation',
        version: '1',
        dataVersion: 1,
        configFile: 'investigation.json',
        generate: () => ({ gameplay: [definition] }),
      },
    ],
    packPlugins: [{ id: 'external-rules', version: '1' }],
  })
  const world = await openRpgWorld(f.pack, f.data, { composition })
  await world.close()
  const reopened = await openRpgWorld(f.pack, f.data, { composition })
  cleanup.push(() => reopened.close())
  expect(
    reopened
      .events()
      .filter(event => event.eventType === 'status.updated')
      .flatMap(event => (event.data as any).changes ?? []),
  ).toContainEqual({ holderId: 'character:player', key: 'energy', value: 1 })
})
