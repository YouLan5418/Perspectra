import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEventBook } from '@perspectra/sdk'
import { compileWorldPackSource, packContentFacts, validatePluginConfig } from '@perspectra/world-pack'
import { describeAuthoringCapability, listAuthoringCapabilities } from '../../apps/host/src/authoring-catalog.ts'
import { officialPackPlugins } from '../../apps/host/src/official-pack-metadata.ts'
import { loadTables } from '../../apps/host/src/runtime/table-source.ts'

const events = 'official-world-events/scheduled-notice'
const tables = 'official-dice/encounter-tables'
const contacts = 'official-communication/contacts'
const facts = {
  characterIds: ['character:player', 'character:companion'],
  playerId: 'character:player',
  locationIds: ['location:start'],
  entityIds: [],
  entityLocations: {},
  names: {},
}
function cli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'apps/host/src/cli/worldpack.ts', ...args],
    { encoding: 'utf8' },
  )
}
it('publishes versioned, detached descriptions from the same installed metadata, with no pack or Host claim', () => {
  const index = listAuthoringCapabilities()
  expect(index).toMatchObject({
    coverage: 'partial',
    authority: 'none',
    packAvailability: 'not-evaluated',
    hostAvailability: 'not-evaluated',
    sourceSchemaVersion: 'worldpack-source/v5',
  })
  expect(index.capabilities.map(row => row.id)).toEqual(expect.arrayContaining([events, tables, contacts]))
  expect(new Set(index.capabilities.map(row => row.id)).size).toBe(index.capabilities.length)
  for (const row of index.capabilities) {
    const { capability } = describeAuthoringCapability(row.id)
    expect(capability).toMatchObject(row)
    expect(capability.version).toBeGreaterThan(0)
    const provider = officialPackPlugins.find(p => p.id === row.provider.id)!
    expect(row.provider.version).toBe(provider.version)
    validatePluginConfig(provider, capability.example.config, facts)
    expect(capability.example.manifestFragment.assetFiles).toContain(capability.example.file)
    expect(capability.verify.length).toBeGreaterThan(0)
  }
  const detail = describeAuthoringCapability(contacts).capability
  expect(detail.configuration.schema).toEqual(officialPackPlugins.find(p => p.id === detail.provider.id)!.configSchema)
  Object.assign(detail.configuration.schema!, { type: 'broken' })
  expect(describeAuthoringCapability(contacts).capability.configuration.schema).toMatchObject({ type: 'object' })
})

it('uses the existing CLI envelopes for discovery, detail and unsupported IDs', () => {
  const list = cli('catalog', 'list'),
    detail = cli('catalog', 'detail', events),
    missing = cli('catalog', 'detail', 'future/live-notice')
  expect([list.status, detail.status, missing.status]).toEqual([0, 0, 1])
  expect(JSON.parse(list.stdout)).toMatchObject({ command: 'catalog.list', ...listAuthoringCapabilities() })
  expect(JSON.parse(detail.stdout)).toMatchObject({ command: 'catalog.detail', ...describeAuthoringCapability(events) })
  expect(missing.stdout).toBe('')
  expect(JSON.parse(missing.stderr)).toMatchObject({
    errorCode: 'INVALID_REQUEST',
    message: expect.stringContaining('future/live-notice'),
  })
  expect(cli('catalog', 'list', 'extra').status).toBe(1)
})

it('keeps a scheduled notice tied to its boolean write and its versioned event type', () => {
  const { capability } = describeAuthoringCapability(events)
  const [rule] = parseEventBook(capability.example.config, facts).rules
  expect(rule).toMatchObject({ round: 2, set: { key: 'bell-rang', value: true } })
  expect(capability.requiredPlugins).toContain('pack-scripts')
  const input = { id: 'bell', type: 'town.bell@1', round: 2, location: 'location:start', observation: '钟响了。' }
  expect(() => parseEventBook({ rules: [input] }, facts)).toThrow()
  expect(() => parseEventBook({ rules: [{ ...input, set: rule!.set, type: 'town.bell' }] }, facts)).toThrow(/versioned/)
  expect(() => parseEventBook({ rules: [{ ...input, set: rule!.set, sceneNotices: [] }] }, facts)).toThrow(/calendar/)
})

it('loads the advertised table only when the selected dice plugin points to its locked config; rejects wrong provider versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'author-catalog-'))
  try {
    cpSync('examples/world-packs/porch-note', dir, { recursive: true })
    const { example, configuration, provider } = describeAuthoringCapability(tables).capability
    expect(configuration.defaultFile).toBeNull()
    const read = (file: string) => readFileSync(join(dir, file), 'utf8')
    const manifest = JSON.parse(read('worldpack.source.json'))
    manifest.plugins = { ...manifest.plugins, ...example.manifestFragment.plugins }
    manifest.assetFiles.push(...example.manifestFragment.assetFiles)
    writeFileSync(join(dir, example.file), JSON.stringify(example.config))
    const save = () => writeFileSync(join(dir, 'worldpack.source.json'), JSON.stringify(manifest))
    save()
    let pack = await compileWorldPackSource(dir, [])
    expect(loadTables(pack, read)?.tables).toEqual(example.config.tables)
    expect(packContentFacts(pack).locationIds).toContain('location:start')
    delete manifest.plugins[provider.id].config
    save()
    pack = await compileWorldPackSource(dir, [])
    expect(loadTables(pack, read)).toBeUndefined()
    manifest.plugins[provider.id].version = 'unavailable'
    save()
    const invalid = cli('validate', dir)
    expect(invalid.status).toBe(1)
    expect(JSON.parse(invalid.stderr).message).toContain('required version unavailable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
