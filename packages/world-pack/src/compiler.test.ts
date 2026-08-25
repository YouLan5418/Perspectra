import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandId, canonicalizeWorldJson, type WorldJsonValue } from '@harness-world/contracts'
import { WorldApplication } from '@harness-world/application'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import {
  WorldPackCompiler,
  assertCompatiblePackVersion,
  canonicalWorldPackBytes,
  verifyCompiledWorldPack,
} from './compiler.ts'
import { WorldPackContractError } from './diagnostics.ts'
import { parseStrictWorldJson } from './strict-json.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'world-pack-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function manifest(overrides: Record<string, unknown> = {}): WorldJsonValue {
  return {
    sourceSchemaVersion: 'worldpack-source/v1', packId: 'pack:tavern', packVersion: '1.0.0',
    worldFile: 'world.json', characterFiles: ['characters.json'], locationFiles: ['locations.json'],
    sceneFiles: ['scenes.json'], playerSlotFiles: ['player-slots.json'], presentationFiles: ['presentation.json'],
    markdownFiles: ['text/bob.md'], assetFiles: ['assets/map.bin'], assertionFiles: ['assertions.json'],
    ...overrides,
  } as WorldJsonValue
}

const sourceDocuments: Record<string, WorldJsonValue> = {
  'world.json': {
    schemaVersion: 'worldpack-world/v1', title: 'Tavern', description: 'A social room',
    initialFacts: [{ factId: 'fact:secret', proposition: { text: 'Bob owns the cellar' }, initialAudience: ['character:bob'] }],
  },
  'locations.json': { schemaVersion: 'worldpack-locations/v1', locations: [
    { locationId: 'location:yard', name: 'Yard' }, { locationId: 'location:tavern', name: 'Tavern' },
  ] },
  'characters.json': {
    schemaVersion: 'worldpack-characters/v1',
    characters: [
      { characterId: 'character:alice', displayName: 'Alice', initialLocationId: 'location:tavern' },
      {
        characterId: 'character:bob', displayName: 'Bob', initialLocationId: 'location:tavern',
        portrayal: { backgroundTextRef: 'text/bob.md' },
        initialObservations: [{ observationId: 'observation:bob', value: { text: 'Alice arrived' } }],
        initialClaims: [{ claimId: 'claim:bob', value: { text: 'Alice is late' } }],
        initialGoals: [{ goalId: 'goal:bob', value: { text: 'Close the cellar' } }],
      },
    ],
  },
  'scenes.json': { schemaVersion: 'worldpack-scenes/v1', scenes: [{ sceneId: 'scene:tavern', participantIds: ['character:alice', 'character:bob'] }] },
  'player-slots.json': { schemaVersion: 'worldpack-player-slots/v1', playerSlots: [{ slotId: 'slot:player', characterId: 'character:alice' }] },
  'presentation.json': { schemaVersion: 'worldpack-presentation/v1', locale: 'zh-CN' },
  'assertions.json': { schemaVersion: 'worldpack-assertions/v1', assertions: [
    { assertionId: 'assertion:view', assertionType: 'view.includes', parameters: { characterId: 'character:bob' } },
    { assertionId: 'assertion:secret', assertionType: 'view.excludes', parameters: { characterId: 'character:alice', factId: 'fact:secret' } },
  ] },
}

async function writeJson(root: string, path: string, value: WorldJsonValue): Promise<void> {
  const target = join(root, ...path.split('/'))
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, canonicalizeWorldJson(value))
}

async function writePack(root: string, rootManifest: WorldJsonValue = manifest(), markdown = 'Bob\r\nkeeps a secret.\r\n'): Promise<void> {
  await writeJson(root, 'worldpack.source.json', rootManifest)
  for (const [path, value] of Object.entries(sourceDocuments)) await writeJson(root, path, value)
  await mkdir(join(root, 'text'), { recursive: true })
  await writeFile(join(root, 'text', 'bob.md'), markdown, 'utf8')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'map.bin'), new Uint8Array([0, 1, 2, 255]))
}

async function writeSplitPack(root: string, reverse: boolean, markdown: string): Promise<void> {
  const locationFiles = reverse ? ['locations-b.json', 'locations-a.json'] : ['locations-a.json', 'locations-b.json']
  const characterFiles = reverse ? ['characters-b.json', 'characters-a.json'] : ['characters-a.json', 'characters-b.json']
  await writePack(root, manifest({ locationFiles, characterFiles }), markdown)
  const locations = (sourceDocuments['locations.json'] as { locations: readonly WorldJsonValue[] }).locations
  const characters = (sourceDocuments['characters.json'] as { characters: readonly WorldJsonValue[] }).characters
  await writeJson(root, 'locations-a.json', { schemaVersion: 'worldpack-locations/v1', locations: [locations[0]!] })
  await writeJson(root, 'locations-b.json', { schemaVersion: 'worldpack-locations/v1', locations: [locations[1]!] })
  await writeJson(root, 'characters-a.json', { schemaVersion: 'worldpack-characters/v1', characters: [characters[0]!] })
  await writeJson(root, 'characters-b.json', { schemaVersion: 'worldpack-characters/v1', characters: [characters[1]!] })
}

function contractError(error: unknown): WorldPackContractError {
  expect(error).toBeInstanceOf(WorldPackContractError)
  return error as WorldPackContractError
}

async function rejected(run: () => Promise<unknown>, code: string): Promise<WorldPackContractError> {
  try {
    await run()
  } catch (error) {
    const contract = contractError(error)
    expect(contract.diagnostics[0].code).toBe(code)
    return contract
  }
  throw new Error('expected WorldPackContractError')
}

describe('strict World JSON source grammar', () => {
  it('parses every World JSON value form and whitespace without normalizing Unicode', () => {
    expect(parseStrictWorldJson(' { "a" : [true,false,null,"e\\u0301",-2,0,{},[]] } \n', 'x.json')).toEqual({
      a: [true, false, null, 'e\u0301', -2, 0, {}, []],
    })
  })

  it.each([
    '', '1 trailing', '{"a":1,"a":2}', '{a:1}', '{"a" 1}', '{"a":1 "b":2}',
    '[1 2]', '[1,]', '{"a":1,}', 'tru', 'nil', '1.0', '1e2', '-0', '9007199254740992',
    '"unterminated', '"line\nbreak"', '"bad\\x"', '"\\ud800"',
  ])('rejects invalid or non-World JSON %#', (source) => {
    expect(() => parseStrictWorldJson(source, 'x.json')).toThrow(WorldPackContractError)
  })
})

describe('WorldPackCompiler', () => {
  it('compiles stable canonical bytes, normalized Markdown and a content-bound WorldSpec', async () => {
    const root = await temporaryRoot(); await writePack(root)
    const compiler = new WorldPackCompiler()
    const pack = await compiler.compile(root)
    expect(pack).toMatchObject({
      compiledSchemaVersion: 'worldpack/v1', packId: 'pack:tavern', packVersion: '1.0.0',
      content: { world: { description: 'A social room' }, presentation: { locale: 'zh-CN', style: 'plain' } },
    })
    expect(pack.content.markdown).toEqual([{
      path: 'text/bob.md', text: 'Bob\nkeeps a secret.\n',
      contentHash: 'sha256:b0a6460afb83ef07ddeddcdd0cb0b1c796729a69ffc5079790c19c9a17935fbf',
    }])
    expect(pack.assets).toEqual([{ path: 'assets/map.bin', contentHash: 'sha256:3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56', size: 4 }])
    expect(pack.packHash).toBe('sha256:edf5247e4a5f70658bc7255384cf012df53b68874a8fef83c0ee0610414da230')
    const canonicalBytes = canonicalWorldPackBytes(pack)
    expect(canonicalBytes).toEqual(canonicalizeWorldJson(pack))
    expect(canonicalBytes.byteLength).toBe(3307)
    expect(createHash('sha256').update(canonicalBytes).digest('hex')).toBe(
      '9e7346c6d3e5b609e0d48b00046ce00b8da6589aa57059eeaa28ddd8f586d8a6',
    )
    expect(verifyCompiledWorldPack(pack)).toEqual(pack)

    const compiled = compiler.adaptToWorldSpec(pack, {
      address: { tenantId: brandId('tenant:test', 'TenantId'), worldId: brandId('world:tavern', 'WorldId'), branchId: brandId('branch:main', 'BranchId') },
      principalId: 'principal:player', sessionId: brandId('session:player', 'SessionId'),
    })
    expect(compiled.manifest).toMatchObject({
      schemaVersion: 3,
      metadata: { title: 'Tavern', description: 'A social room' },
      runtimePolicy: { npcInitialAvailability: 'provisioning', playerInitialAvailability: 'ready' },
      rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
      contentPack: { packId: 'pack:tavern', packVersion: '1.0.0', packHash: pack.packHash },
      playerBindings: [{ principalId: 'principal:player', characterId: 'character:alice', sessionId: 'session:player' }],
    })
    expect(compiled.manifest.claims).toHaveLength(2)
    expect(compiled.manifest.goals).toHaveLength(1)
    expect(compiled.manifest.observations).toHaveLength(1)
    expect(compiled.manifest.plugins.map(value => value.pluginId)).toEqual([
      'builtin:agent-context', 'builtin:deterministic-presentation', 'builtin:scene-decision',
    ])
  })

  it('activates Pack cognition through Genesis and preserves isolation across restart and fork', async () => {
    const root = await temporaryRoot(); await writePack(root)
    const characterDocument = structuredClone(sourceDocuments['characters.json']) as {
      characters: Array<Record<string, WorldJsonValue>>
    }
    characterDocument.characters[1] = { ...characterDocument.characters[1]!, lifecycle: 'departed' }
    await writeJson(root, 'characters.json', characterDocument as unknown as WorldJsonValue)
    const compiler = new WorldPackCompiler()
    const pack = await compiler.compile(root)
    const parent = {
      tenantId: brandId('tenant:pack-runtime', 'TenantId'),
      worldId: brandId('world:pack-runtime', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const child = { ...parent, branchId: brandId('branch:fork', 'BranchId') }
    const compiled = compiler.adaptToWorldSpec(pack, {
      address: parent,
      principalId: 'principal:player',
      sessionId: brandId('session:player', 'SessionId'),
    })
    expect(compiled.genesisEvents.map(event => event.eventType)).toContain('character.lifecycle-changed')
    const worldPath = join(root, 'runtime-world.sqlite')
    const sessionPath = join(root, 'runtime-session.sqlite')
    const memoryPath = join(root, 'runtime-memory.sqlite')
    const alice = brandId('character:alice', 'CharacterId')
    const bob = brandId('character:bob', 'CharacterId')

    const first = new WorldApplication({ worldPath, sessionPath, memoryPath })
    try {
      expect(first.activate(compiled).status).toBe('activated')
      const bobView = await first.characterView(parent, bob)
      const aliceView = await first.characterView(parent, alice)
      expect(bobView.lifecycleState).toBe('departed')
      expect(JSON.stringify(bobView.claims)).toContain('Bob owns the cellar')
      expect(JSON.stringify(aliceView.claims)).not.toContain('Bob owns the cellar')
      expect(JSON.stringify(await first.recallMemory(parent, bob, 'cellar'))).toContain('Bob owns the cellar')
      expect(await first.recallMemory(parent, alice, 'cellar')).toEqual([])
    } finally {
      await first.close()
    }

    const restarted = new WorldApplication({ worldPath, sessionPath, memoryPath })
    let forkSeq: number
    try {
      expect(restarted.activate(compiled).status).toBe('already_active')
      forkSeq = (await restarted.head(parent)).headSeq
      expect((await restarted.characterView(parent, bob)).bundleHash)
        .toBe((await restarted.characterView(parent, bob, forkSeq)).bundleHash)
      expect(JSON.stringify(await restarted.recallMemory(parent, bob, 'cellar', forkSeq)))
        .toContain('Bob owns the cellar')
    } finally {
      await restarted.close()
    }

    const store = new WorldStore(worldPath)
    const leases = new WriterLeaseService(worldPath)
    try {
      store.forkBranch(parent, child, forkSeq!)
      const lease = leases.acquire(parent, 'world-pack-future-writer')
      const head = store.head(parent)
      await store.commitRound({
        address: parent,
        transactionId: brandId('transaction:pack-future', 'TransactionId'),
        roundId: brandId('round:pack-future', 'InteractionRoundId'),
        expectedHeadSeq: head.headSeq,
        expectedTick: head.tick,
        nextTick: head.tick + 1,
        events: [
          {
            eventType: 'claim.upsert', eventVersion: 1,
            data: { id: 'claim:future', value: { characterId: bob, proposition: 'FUTURE_CANARY' } },
          },
          { eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1 } },
        ],
        outbox: [],
        cognitiveJobs: [{ characterId: bob }],
        correlationId: 'world-pack-future',
        writerFencingToken: lease.fencingToken,
      })
      leases.release(parent, 'world-pack-future-writer', lease.fencingToken)
    } finally {
      leases.close()
      store.close()
    }

    const forked = new WorldApplication({ worldPath, sessionPath, memoryPath })
    try {
      expect(JSON.stringify(await forked.recallMemory(parent, bob, 'FUTURE_CANARY'))).toContain('FUTURE_CANARY')
      expect(await forked.recallMemory(child, bob, 'FUTURE_CANARY')).toEqual([])
      expect(JSON.stringify((await forked.characterView(child, bob)).claims)).not.toContain('FUTURE_CANARY')
      expect(forked.getWorld(child).manifestHash).toBe(compiled.manifestHash)
    } finally {
      await forked.close()
    }
  })

  it('is independent of source list order and CRLF/LF choice', async () => {
    const first = await temporaryRoot(); const second = await temporaryRoot()
    await writeSplitPack(first, false, 'Bob\r\nkeeps a secret.\r\n')
    await writeSplitPack(second, true, 'Bob\nkeeps a secret.\n')
    const compiler = new WorldPackCompiler()
    const left = await compiler.compile(first); const right = await compiler.compile(second)
    expect(left.packHash).toBe(right.packHash)
    expect(canonicalWorldPackBytes(left)).toEqual(canonicalWorldPackBytes(right))
  })

  it('detects immutable envelope and human-version divergence', async () => {
    const first = await temporaryRoot(); const second = await temporaryRoot()
    await writePack(first); await writePack(second)
    await writeJson(second, 'world.json', { ...sourceDocuments['world.json'] as object, title: 'Changed Tavern' } as WorldJsonValue)
    const compiler = new WorldPackCompiler(); const left = await compiler.compile(first); const right = await compiler.compile(second)
    expect(() => assertCompatiblePackVersion(left, left)).not.toThrow()
    expect(() => assertCompatiblePackVersion(left, right)).toThrow(WorldPackContractError)
    expect(() => verifyCompiledWorldPack({ ...left, content: { ...left.content, world: { ...left.content.world, title: 'tampered' } } })).toThrow(WorldPackContractError)
  })

  it.each([
    '../outside.json', 'dir\\file.json', 'C:/file.json', '/root.json', './file.json', 'a//b.json',
    'dir./file.json', 'trail /file.json', 'CON',
  ])('rejects non-portable declared path %s', async (unsafe) => {
    const root = await temporaryRoot(); await writePack(root, manifest({ markdownFiles: [unsafe] }))
    await rejected(() => new WorldPackCompiler().compile(root), 'PACK_SOURCE_INVALID')
  })

  it('rejects case-fold collisions and missing or non-file declarations', async () => {
    const collision = await temporaryRoot(); await writePack(collision, manifest({ markdownFiles: ['text/bob.md', 'TEXT/BOB.MD'] }))
    await rejected(() => new WorldPackCompiler().compile(collision), 'PACK_SOURCE_INVALID')
    const missing = await temporaryRoot(); await writePack(missing, manifest({ markdownFiles: ['text/missing.md'] }))
    await rejected(() => new WorldPackCompiler().compile(missing), 'PACK_REFERENCE_INVALID')
    const directory = await temporaryRoot(); await writePack(directory, manifest({ markdownFiles: ['text'] }))
    await rejected(() => new WorldPackCompiler().compile(directory), 'PACK_SOURCE_INVALID')
  })

  it('rejects source roots that are absent or regular files', async () => {
    const root = await temporaryRoot()
    await rejected(() => new WorldPackCompiler().compile(join(root, 'absent')), 'PACK_SOURCE_INVALID')
    const file = join(root, 'file'); await writeFile(file, 'x')
    await rejected(() => new WorldPackCompiler().compile(file), 'PACK_SOURCE_INVALID')
  })

  it('rejects an unknown limits profile before touching the filesystem', async () => {
    await rejected(() => new WorldPackCompiler().compile('unused', { limitsProfile: 'other' as 'worldpack-limits/v1' }), 'PACK_PROFILE_NOT_ALLOWED')
  })

  it('rejects a declared symbolic link escaping the real source root', async () => {
    const root = await temporaryRoot(); const outside = await temporaryRoot(); await writePack(root)
    const outsideFile = join(outside, 'outside.md'); await writeFile(outsideFile, 'outside')
    await symlink(outsideFile, join(root, 'text', 'escape.md'), 'file')
    await writeJson(root, 'worldpack.source.json', manifest({ markdownFiles: ['text/escape.md'] }))
    await rejected(() => new WorldPackCompiler().compile(root), 'PACK_SOURCE_INVALID')
  })

  it('rejects invalid UTF-8, bare CR and source size limits', async () => {
    const utf8 = await temporaryRoot(); await writePack(utf8); await writeFile(join(utf8, 'text', 'bob.md'), new Uint8Array([0xc3, 0x28]))
    await rejected(() => new WorldPackCompiler().compile(utf8), 'PACK_SOURCE_INVALID')
    const carriage = await temporaryRoot(); await writePack(carriage, manifest(), 'a\rb')
    await rejected(() => new WorldPackCompiler().compile(carriage), 'PACK_SOURCE_INVALID')
    const markdown = await temporaryRoot(); await writePack(markdown, manifest(), 'x'.repeat(256 * 1024 + 1))
    await rejected(() => new WorldPackCompiler().compile(markdown), 'PACK_LIMIT_EXCEEDED')
    const json = await temporaryRoot(); await writePack(json); await writeFile(join(json, 'world.json'), `{"schemaVersion":"worldpack-world/v1","title":"${'x'.repeat(1024 * 1024)}"}`)
    await rejected(() => new WorldPackCompiler().compile(json), 'PACK_LIMIT_EXCEEDED')
    const asset = await temporaryRoot(); await writePack(asset); await writeFile(join(asset, 'assets', 'map.bin'), new Uint8Array(8 * 1024 * 1024 + 1))
    await rejected(() => new WorldPackCompiler().compile(asset), 'PACK_LIMIT_EXCEEDED')
  })

  it('rejects aggregate declared byte limits', async () => {
    const root = await temporaryRoot(); await writePack(root, manifest({ assetFiles: ['assets/a', 'assets/b', 'assets/c'] }))
    for (const file of ['a', 'b', 'c']) await writeFile(join(root, 'assets', file), new Uint8Array(6 * 1024 * 1024))
    await rejected(() => new WorldPackCompiler().compile(root), 'PACK_LIMIT_EXCEEDED')
  })

  it.each([
    ['unknown location', (value: Record<string, WorldJsonValue>) => ({ ...value, characters: [{ characterId: 'character:alice', displayName: 'Alice', initialLocationId: 'location:missing' }] }), 'characters.json'],
    ['unknown Markdown', (value: Record<string, WorldJsonValue>) => ({ ...value, characters: [{ characterId: 'character:alice', displayName: 'Alice', initialLocationId: 'location:tavern', portrayal: { backgroundTextRef: 'text/missing.md' } }] }), 'characters.json'],
    ['unknown Scene Character', (value: Record<string, WorldJsonValue>) => ({ ...value, scenes: [{ sceneId: 'scene:tavern', participantIds: ['character:missing'] }] }), 'scenes.json'],
    ['unknown Player Character', (value: Record<string, WorldJsonValue>) => ({ ...value, playerSlots: [{ slotId: 'slot:player', characterId: 'character:missing' }] }), 'player-slots.json'],
    ['player outside Scene', (value: Record<string, WorldJsonValue>) => ({ ...value, scenes: [{ sceneId: 'scene:tavern', participantIds: ['character:bob'] }] }), 'scenes.json'],
    ['unknown fact audience', (value: Record<string, WorldJsonValue>) => ({ ...value, initialFacts: [{ factId: 'fact:x', proposition: true, initialAudience: ['character:missing'] }] }), 'world.json'],
  ])('rejects %s references', async (_name, mutate, file) => {
    const root = await temporaryRoot(); await writePack(root)
    await writeJson(root, file, mutate(sourceDocuments[file] as Record<string, WorldJsonValue>) as WorldJsonValue)
    await rejected(() => new WorldPackCompiler().compile(root), 'PACK_REFERENCE_INVALID')
  })

  it('rejects duplicates across split documents and multiple singleton documents', async () => {
    const duplicate = await temporaryRoot(); await writePack(duplicate, manifest({ characterFiles: ['characters.json', 'characters-copy.json'] }))
    await writeJson(duplicate, 'characters-copy.json', sourceDocuments['characters.json']!)
    await rejected(() => new WorldPackCompiler().compile(duplicate), 'PACK_DUPLICATE_ID')
    const presentations = await temporaryRoot(); await writePack(presentations, manifest({ presentationFiles: ['presentation.json', 'presentation-copy.json'] }))
    await writeJson(presentations, 'presentation-copy.json', sourceDocuments['presentation.json']!)
    await rejected(() => new WorldPackCompiler().compile(presentations), 'PACK_SOURCE_INVALID')
    const scenes = await temporaryRoot(); await writePack(scenes, manifest({ sceneFiles: ['scenes.json', 'scenes-copy.json'] }))
    await writeJson(scenes, 'scenes-copy.json', { schemaVersion: 'worldpack-scenes/v1', scenes: [{ sceneId: 'scene:other', participantIds: ['character:alice'] }] })
    await rejected(() => new WorldPackCompiler().compile(scenes), 'PACK_SOURCE_INVALID')
  })
})
