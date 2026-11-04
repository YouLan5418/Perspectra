import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileWorldPackSource, verifyCompiledWorldPackV5 } from '@harness-world/world-pack'
import { interactionPackageDescription } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadHostPlugins } from '../../desktop/host-plugins.ts'
import { LauncherCore } from '../../desktop/launcher-core.ts'
import {
  checkPluginRequirements,
  requirementMessage,
  satisfiesVersion,
  type RequirementProblem,
} from '../../desktop/plugin-requirements.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const LOCKED = fileURLToPath(new URL('../../examples/host-plugins/locked-room.mjs', import.meta.url))
const DYNAMIC_HASH = 'sha256:e2542e11fe87eaadefa291d6bf4438c79602109b38db9c664d598c7dc9ade8cc'

async function packWith(requiresPlugins: unknown): Promise<string> {
  const pack = await mkdtemp(join(tmpdir(), 'perspectra-requires-'))
  roots.push(pack)
  await cp(resolve('examples/world-packs/dynamic-scheduling'), pack, { recursive: true })
  const file = join(pack, 'worldpack.source.json')
  const source = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...source, requiresPlugins }, null, 2))
  return pack
}
const compile = (pack: string) =>
  compileWorldPackSource(pack, createInstalledInteractionPackages().map(interactionPackageDescription))

const local = {
  id: '6f1c2a4e-1d0b-4c39-9a51-0d6c1b7e2f10',
  name: '本地',
  protocol: 'openai',
  endpoint: 'http://127.0.0.1:8046/v1/chat/completions',
} as const
async function launcherWith(pack: string) {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-requires-launcher-'))
  roots.push(root)
  const core = new LauncherCore(resolve('.'), root)
  await core.initialize()
  await core.handle({ operation: 'connection-save', connection: local })
  await core.handle({ operation: 'load', path: pack })
  await core.handle({
    operation: 'create',
    packageId: core.snapshot().packs[0]!.id,
    name: '依赖测试',
    models: { decision: { connectionId: local.id, model: 'fixture' } },
  })
  vi.stubEnv('HCW_HINDSIGHT_PYTHON', process.execPath)
  return { core, instanceId: core.snapshot().instances[0]!.id }
}

describe('version ranges', () => {
  it('holds the first nonzero caret component and never treats prereleases as stable', () => {
    expect(satisfiesVersion('0.0.1', '^0.0.1')).toBe(true)
    expect(satisfiesVersion('0.0.9', '^0.0.1')).toBe(false)
    expect(satisfiesVersion('1.2.3-beta.1', '1.2.3')).toBe(false)
    expect(satisfiesVersion('1.2.3-beta.1', '>=1.2.0')).toBe(false)
    expect(satisfiesVersion('1.2.3+build.7', '1.2.3')).toBe(true)
  })

  it('accepts exact, caret and at-least ranges', () => {
    expect(satisfiesVersion('1.2.3', '1.2.3')).toBe(true)
    expect(satisfiesVersion('1.2.4', '1.2.3')).toBe(false)
    expect(satisfiesVersion('1.9.0', '^1.2.0')).toBe(true)
    expect(satisfiesVersion('2.0.0', '^1.2.0')).toBe(false)
    expect(satisfiesVersion('0.1.5', '^0.1.0')).toBe(true)
    expect(satisfiesVersion('0.2.0', '^0.1.0')).toBe(false)
    expect(satisfiesVersion('3.0.0', '>=1.2.3')).toBe(true)
    expect(satisfiesVersion('1.2.2', '>=1.2.3')).toBe(false)
    expect(satisfiesVersion('not-a-version', '>=1.2.3')).toBe(false)
  })
})

describe('checking requirements', () => {
  const required = [
    { id: 'gone', version: '^1.0.0' },
    { id: 'off', version: '^1.0.0' },
    { id: 'old', version: '^2.0.0' },
    { id: 'fine', version: '^1.0.0' },
    { id: 'extra', version: '^1.0.0', optional: true },
  ]
  const installed = [
    { id: 'off', version: '1.0.0', enabled: false },
    { id: 'old', version: '1.5.0', enabled: true },
    { id: 'fine', version: '1.1.0', enabled: true },
  ]

  it('lists every missing, disabled and mismatched plugin at once', () => {
    const problems = checkPluginRequirements(required, installed)
    expect(problems.map(problem => [problem.id, problem.kind])).toEqual([
      ['gone', 'missing'],
      ['off', 'disabled'],
      ['old', 'version'],
      ['extra', 'missing'],
    ])
    const message = requirementMessage(problems.filter(problem => !problem.optional))
    for (const id of ['gone', 'off', 'old']) expect(message).toContain(id)
    expect(message).toContain('1.5.0')
  })

  it('does not let a plugin without a manifest id satisfy a requirement', () => {
    const problems: RequirementProblem[] = checkPluginRequirements(
      [{ id: 'fine', version: '^1.0.0' }],
      [{ enabled: true }],
    )
    expect(problems[0]!.kind).toBe('missing')
  })

  it('only warns about an optional requirement', () => {
    expect(checkPluginRequirements(required, installed).find(problem => problem.id === 'extra')?.optional).toBe(true)
  })
})

describe('world packs', () => {
  it('keeps requiresPlugins in the compiled pack', async () => {
    const compiled = await compile(await packWith([{ id: 'locked-room', version: '^0.1.0' }]))
    expect(compiled.requiresPlugins).toEqual([{ id: 'locked-room', version: '^0.1.0' }])
    expect(compiled.packHash).not.toBe(DYNAMIC_HASH)
  })

  it('survives the check every world goes through when it opens', async () => {
    const compiled = await compile(await packWith([{ id: 'locked-room', version: '^0.1.0' }]))
    expect(verifyCompiledWorldPackV5(compiled).requiresPlugins).toEqual([{ id: 'locked-room', version: '^0.1.0' }])
  })

  it('rejects a malformed requiresPlugins when compiling', async () => {
    await expect(compile(await packWith([{ id: 'Bad Id', version: '^0.1.0' }]))).rejects.toThrow()
    await expect(compile(await packWith([{ id: 'ok', version: 'latest' }]))).rejects.toThrow()
    await expect(compile(await packWith([{ id: 'ok', version: '1.0.0', extra: true }]))).rejects.toThrow()
    await expect(
      compile(
        await packWith([
          { id: 'ok', version: '1.0.0' },
          { id: 'ok', version: '2.0.0' },
        ]),
      ),
    ).rejects.toThrow()
  })

  it('keeps the pack hash when requiresPlugins is absent', async () => {
    const compiled = await compile(resolve('examples/world-packs/dynamic-scheduling'))
    expect(compiled.packHash).toBe(DYNAMIC_HASH)
    expect('requiresPlugins' in compiled).toBe(false)
  })
})

describe('launcher', () => {
  it('refuses to launch and lists every problem', async () => {
    const { core, instanceId } = await launcherWith(
      await packWith([
        { id: 'locked-room', version: '^0.1.0' },
        { id: 'another', version: '^1.0.0' },
      ]),
    )
    await expect(core.handle({ operation: 'start', instanceId })).rejects.toThrow(/locked-room[\s\S]*another/u)
    expect(core.snapshot().core.state).toBe('idle')
  })

  it('reads the installed version from the manifest, and passes once the plugin is enabled', async () => {
    const { core, instanceId } = await launcherWith(await packWith([{ id: 'locked-room', version: '^0.1.0' }]))
    await core.handle({
      operation: 'preferences',
      theme: 'system',
      largeText: false,
      hostPlugins: [{ id: 'mine', path: LOCKED, enabled: false, config: { locationId: 'location:front-room' } }],
    })
    await expect(core.handle({ operation: 'start', instanceId })).rejects.toThrow('没有启用')
    await core.handle({
      operation: 'preferences',
      theme: 'system',
      largeText: false,
      hostPlugins: [{ id: 'mine', path: LOCKED, enabled: true, config: { locationId: 'location:front-room' } }],
    })
    await expect(core.checkPackPlugins(core.snapshot().packs[0]!.path)).resolves.toBe('')
  })

  // The launcher only sees the manifest; the game process finds out the plugin cannot load.
  it('tells the player when the game process refuses a plugin the launcher could not judge', async () => {
    const { core, instanceId } = await launcherWith(await packWith([{ id: 'needs-new-host', version: '^1.0.0' }]))
    const directory = await mkdtemp(join(tmpdir(), 'perspectra-requires-plugin-'))
    roots.push(directory)
    const path = join(directory, 'needs-new-host.mjs')
    await writeFile(path, `export const hostApi = '9.0'; export default () => {}`)
    await writeFile(
      join(directory, 'needs-new-host.plugin.json'),
      JSON.stringify({ id: 'needs-new-host', name: '要新宿主', version: '1.0.0', services: [] }),
    )
    await core.handle({
      operation: 'preferences',
      theme: 'system',
      largeText: false,
      hostPlugins: [{ id: 'mine', path, enabled: true, config: {} }],
    })
    const failure = String(await core.handle({ operation: 'start', instanceId }).catch((error: Error) => error))
    expect(failure).toContain('这个世界包需要的插件有问题')
    expect(failure).toContain('needs-new-host')
    expect(failure).not.toContain('Core 初始化失败')
    expect(core.snapshot().core.state).toBe('idle')
  }, 60_000)

  it('notes a missing optional plugin without refusing', async () => {
    const { core } = await launcherWith(await packWith([{ id: 'locked-room', version: '^0.1.0', optional: true }]))
    await expect(core.checkPackPlugins(core.snapshot().packs[0]!.path)).resolves.toContain('locked-room')
  })
})

describe('game process', () => {
  it('counts a plugin the loader skipped as not in force', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = await loadHostPlugins([{ id: 'mine', enabled: true, path: LOCKED, config: {} }])
    try {
      expect(session.installed).toEqual([{ id: 'locked-room', version: '0.1.0', enabled: false }])
      expect(checkPluginRequirements([{ id: 'locked-room', version: '^0.1.0' }], session.installed)[0]!.kind).toBe(
        'disabled',
      )
    } finally {
      await session.close()
    }
  })

  it('counts a loaded plugin as in force', async () => {
    const session = await loadHostPlugins([
      { id: 'mine', enabled: true, path: LOCKED, config: { locationId: 'location:front-room' } },
    ])
    try {
      expect(checkPluginRequirements([{ id: 'locked-room', version: '^0.1.0' }], session.installed)).toEqual([])
    } finally {
      await session.close()
    }
  })
})

describe('python check', () => {
  it('does not ask for Python when an enabled plugin provides memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perspectra-memory-plugin-'))
    roots.push(root)
    const entry = join(root, 'memory.mjs')
    await writeFile(entry, "export const hostApi = '1.4'\nexport default () => {}\n")
    await writeFile(
      join(root, 'memory.plugin.json'),
      JSON.stringify({ id: 'memory', name: '记忆', version: '1.0.0', services: ['memory'] }),
    )
    const { core } = await launcherWith(resolve('examples/world-packs/dynamic-scheduling'))
    await expect(core.needsCorePython()).resolves.toBe(true)
    await core.handle({
      operation: 'preferences',
      theme: 'system',
      largeText: false,
      hostPlugins: [{ id: 'memory', path: entry, enabled: true }],
    })
    await expect(core.needsCorePython()).resolves.toBe(false)
    await core.handle({
      operation: 'preferences',
      theme: 'system',
      largeText: false,
      hostPlugins: [{ id: 'memory', path: entry, enabled: false }],
    })
    await expect(core.needsCorePython()).resolves.toBe(true)
  })
})
