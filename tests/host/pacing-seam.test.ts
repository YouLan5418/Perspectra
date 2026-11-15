import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { PacingInstance, SeamProvider } from '@harness-world/plugin-sdk'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { assembleRoleplay, type WorldComposition } from '../../desktop/official-bundle.ts'
import { PluginFaultError } from '../../desktop/host/plugin-runtime.ts'
import { fakeModels } from '../support/fake-provider.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const good = {
  cycleRounds: 16,
  chance: 0.35,
  cooldownRounds: { low: 2, medium: 4, high: 8 },
  recoveryRounds: 3,
  stagnation: {
    afterRounds: 6,
    progress: { statuses: ['gold'], activities: ['battle'] },
    maxChance: 0.8,
    maxTensionBoost: 0.4,
  },
  activities: { battle: { intensity: 'high' } },
  beats: { knock: { intensity: 'low' } },
}
const script = (
  definition: unknown,
  beats = `{ knock: { when: () => [true], apply: () => ({ changes: [], reveals: [] }) } }`,
) => `globalThis.pacingScript = { definition: ${JSON.stringify(definition)}, beats: ${beats} }`

function pack(pacing: string | undefined, base = 'rpg-turn-battle', onlyPacing = false) {
  const root = mkdtempSync(join(tmpdir(), 'pacing-seam-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const path = join(root, 'pack')
  cpSync(resolve('examples/world-packs', base), path, { recursive: true })
  if (pacing !== undefined) {
    mkdirSync(join(path, 'scripts'), { recursive: true })
    writeFileSync(join(path, 'scripts/pacing.js'), pacing)
    const file = join(path, 'worldpack.source.json'),
      manifest = JSON.parse(readFileSync(file, 'utf8'))
    if (onlyPacing) manifest.assetFiles = []
    manifest.assetFiles.push('scripts/pacing.js')
    manifest.plugins = { ...manifest.plugins, 'official-pacing': {} }
    writeFileSync(file, JSON.stringify(manifest))
  }
  return { root, path }
}
async function open(packPath: string, root: string, composition: WorldComposition = assembleRoleplay()) {
  const runtime = await WorldHostRuntime.create({
    packPath,
    dataDirectory: join(root, 'data'),
    models: fakeModels('http://127.0.0.1:1/api/chat', 'openai', 'unused'),
    timeoutMs: 1000,
    composition,
  })
  cleanups.push(() => runtime.close())
  return runtime
}

async function expectOfficialPacingFault(
  start: () => Promise<unknown>,
  operation: string,
  invalidResult: boolean,
): Promise<void> {
  const failure = await start().then(
    () => {
      throw new Error('expected the pacing plugin to block opening')
    },
    error => error,
  )
  expect(failure).toBeInstanceOf(PluginFaultError)
  if (!(failure instanceof PluginFaultError)) return
  expect(failure).toMatchObject({
    origin: 'plugin',
    pluginId: 'official-pacing',
    operation,
    invalidResult,
  })
  expect(failure.message).toBe(
    invalidResult
      ? `插件 official-pacing 的 ${operation} 返回了无效结果。`
      : `插件 official-pacing 的 ${operation} 操作失败。`,
  )
}

const seams = (root: string) => JSON.parse(readFileSync(join(root, 'data', 'plugin-set.json'), 'utf8')).seams

it('opens an empty pacing capability without enabling authored pacing', async () => {
  const { path, root } = pack(undefined)
  await open(path, root)
  expect(seams(root).pacing).toEqual([{ id: 'official-pacing', version: '1.0.0' }])
})

it('opens a world with a valid pacing script', async () => {
  const { path, root } = pack(script(good))
  await expect(open(path, root)).resolves.toBeDefined()
})

it('refuses a declared script when the selection leaves the mechanism out', async () => {
  const { path, root } = pack(script(good))
  const standard = assembleRoleplay(),
    { pacing: _pacing, ...mechanisms } = standard.mechanisms
  await expect(open(path, root, { ...standard, mechanisms })).rejects.toThrow('世界声明的 pacing 需要对应机制')
})

it('uses and closes a selected replacement', async () => {
  const { path, root } = pack(script(good))
  let closed = false
  const replacement: SeamProvider<PacingInstance> = {
    id: 'other-pacing',
    version: '2.0.0',
    open: async () => ({
      managedActivities: ['battle'],
      beats: [],
      progress: { statuses: [], activities: [] },
      intensity: () => 'high',
      checks: () => [],
      choose: () => ({ kind: 'none', reason: {} }),
      apply: () => ({}),
      close: () => {
        closed = true
      },
    }),
  }
  const runtime = await open(path, root, assembleRoleplay({ pacing: replacement }))
  expect(seams(root).pacing).toEqual([{ id: 'other-pacing', version: '2.0.0' }])
  await runtime.close()
  expect(closed).toBe(true)
})

const invalid: [string, unknown, string, boolean][] = [
  ['unknown field', { ...good, extra: 1 }, 'open', false],
  ['short cycle', { ...good, cycleRounds: 1 }, 'open', false],
  ['chance above one', { ...good, chance: 1.5 }, 'open', false],
  ['negative cooldown', { ...good, cooldownRounds: { low: -1, medium: 1, high: 1 } }, 'open', false],
  ['unknown intensity', { ...good, activities: { battle: { intensity: 'huge' } } }, 'open', false],
  ['max chance below chance', { ...good, stagnation: { ...good.stagnation, maxChance: 0.1 } }, 'open', false],
  ['undeclared activity', { ...good, activities: { nowhere: { intensity: 'low' } } }, 'open:activities', true],
  [
    'undeclared progress status',
    { ...good, stagnation: { ...good.stagnation, progress: { statuses: ['nothing'], activities: [] } } },
    'open:statuses',
    true,
  ],
  [
    'undeclared progress activity',
    { ...good, stagnation: { ...good.stagnation, progress: { statuses: [], activities: ['nowhere'] } } },
    'open:activities',
    true,
  ],
  [
    'beat without an implementation',
    { ...good, beats: { knock: { intensity: 'low' }, rain: { intensity: 'low' } } },
    'open',
    false,
  ],
]
it.each(invalid)(
  'refuses a pacing script with %s as a safe plugin fault',
  async (_name, definition, operation, invalidResult) => {
    const { path, root } = pack(script(definition))
    await expectOfficialPacingFault(() => open(path, root), operation, invalidResult)
  },
)

it('refuses an implemented beat that was not declared', async () => {
  const { path, root } = pack(
    script(
      good,
      `{ knock: { when: () => [true], apply: () => ({}) }, rain: { when: () => [true], apply: () => ({}) } }`,
    ),
  )
  await expectOfficialPacingFault(() => open(path, root), 'open', false)
})

it('refuses an activity that has no start condition', async () => {
  const { path, root } = pack(script({ ...good, stagnation: undefined, activities: { game: { intensity: 'low' } } }))
  writeFileSync(
    join(path, 'scripts/activities/game.js'),
    readFileSync(join(path, 'scripts/activities/battle.js'), 'utf8').replace(/autoStart\(/u, 'unusedAutoStart('),
  )
  const file = join(path, 'worldpack.source.json'),
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.assetFiles.push('scripts/activities/game.js')
  writeFileSync(file, JSON.stringify(manifest))
  await expectOfficialPacingFault(() => open(path, root), 'open:autoStart', true)
})

it('refuses beats in a world with no status declaration', async () => {
  const { path, root } = pack(script({ ...good, stagnation: undefined, activities: {} }), 'rpg-turn-battle', true)
  await expectOfficialPacingFault(() => open(path, root), 'open:status', true)
})

it('allows pacing only activities in a world with no status declaration', async () => {
  const { path, root } = pack(
    `globalThis.pacingScript = { definition: ${JSON.stringify({ ...good, stagnation: undefined, activities: {}, beats: {} })}, beats: {} }`,
    'rpg-turn-battle',
    true,
  )
  await expect(open(path, root)).resolves.toBeDefined()
})
