import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { frontendActionRequest } from '@perspectra/frontend'
import { WorldStore } from '@perspectra/core/store'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { WorldHostRuntime } from '../../apps/host/src/runtime/world-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const obj = (value: unknown) => value as WorldJsonObject
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'pacing-toggle-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return root
}
/** A beat every round, so whether pacing ran is plain to see. */
function pack(pacing = true): string {
  const packPath = join(fresh(), 'pack')
  cpSync(resolve('examples/world-packs/prototype-g1'), packPath, { recursive: true })
  mkdirSync(join(packPath, 'scripts'), { recursive: true })
  writeFileSync(join(packPath, 'scripts/status.js'), readFileSync(resolve('tests/fixtures/status-market.js'), 'utf8'))
  const definition = {
    cycleRounds: 16,
    chance: 1,
    cooldownRounds: { low: 0, medium: 0, high: 0 },
    recoveryRounds: 0,
    beats: { knock: { intensity: 'low' } },
  }
  writeFileSync(
    join(packPath, 'scripts/pacing.js'),
    `globalThis.pacingScript = { definition: ${JSON.stringify(definition)},
      beats: { knock: { when: () => [['总是', true]], apply: () => ({ notice: '有人敲了敲门。' }) } } }`,
  )
  const file = join(packPath, 'worldpack.source.json'),
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.assetFiles = pacing ? ['scripts/status.js', 'scripts/pacing.js'] : ['scripts/status.js']
  delete manifest.scripts
  manifest.plugins = { 'pack-scripts': {}, ...(pacing ? { 'official-pacing': {} } : {}) }
  writeFileSync(file, JSON.stringify(manifest))
  return packPath
}
async function open(packPath: string, dataDirectory = fresh()) {
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  cleanups.push(() => server.close())
  const runtime = await WorldHostRuntime.create({
    packPath,
    dataDirectory,
    models: fakeModels(server.endpoint),
    timeoutMs: 5000,
    storyNodes: true,
  })
  let closed = false
  const close = async () => {
    if (!closed) await runtime.close()
    closed = true
  }
  cleanups.push(close)
  const beats = () => {
    const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
    try {
      return store
        .readEvents(runtime.address)
        .filter(e => e.eventType === 'status.updated' && obj(obj(e.data).source).kind === 'beat').length
    } finally {
      store.close()
    }
  }
  const actions = new FrontendActions(runtime)
  let id = 0
  const setPacing = (enabled: boolean) =>
    actions.perform(
      frontendActionRequest({
        requestId: 'request:' + ++id,
        actionId: 'action:' + id,
        operation: 'setPluginControl',
        payload: { id: 'runtime:pacing', value: enabled },
      }),
    )
  return { runtime, dataDirectory, beats, setPacing, close }
}

it('lets the player switch pacing off and on during play', async () => {
  const f = await open(pack())
  expect(
    projectPlayerView(await f.runtime.state()).pluginControls?.find(control => control.id === 'runtime:pacing')?.value,
  ).toBe(true)
  await f.runtime.submit('你好。')
  expect(f.beats()).toBe(1)
  expect((await f.setPacing(false)).pluginControls?.find(control => control.id === 'runtime:pacing')?.value).toBe(false)
  await f.runtime.submit('还在吗？')
  expect(f.beats()).toBe(1)
  await f.setPacing(true)
  await f.runtime.submit('再说一句。')
  expect(f.beats()).toBe(2)
})

it('remembers the choice when the world is opened again', async () => {
  const packPath = pack()
  const f = await open(packPath)
  await f.setPacing(false)
  await f.close()
  const again = await open(packPath, f.dataDirectory)
  expect(
    projectPlayerView(await again.runtime.state()).pluginControls?.find(control => control.id === 'runtime:pacing')
      ?.value,
  ).toBe(false)
  await again.runtime.submit('你好。')
  expect(again.beats()).toBe(0)
})

it('regenerates a round with the choice that round was played with', async () => {
  const f = await open(pack())
  await f.setPacing(false)
  const state = await f.runtime.submit('你好。')
  await f.setPacing(true)
  await f.runtime.regenerate(state.tailRound!.id!, 'pacing-toggle-regeneration')
  expect(f.beats()).toBe(0)
  // The player's present choice still holds for the next round.
  expect(
    projectPlayerView(await f.runtime.state()).pluginControls?.find(control => control.id === 'runtime:pacing')?.value,
  ).toBe(true)
  await f.runtime.submit('然后呢？')
  expect(f.beats()).toBe(1)
})

it('offers no switch in a world without pacing, and refuses one', async () => {
  const f = await open(pack(false))
  expect(
    projectPlayerView(await f.runtime.state()).pluginControls?.find(control => control.id === 'runtime:pacing'),
  ).toBeUndefined()
  await expect(f.setPacing(false)).rejects.toThrow('不可用')
})

it('accepts only a plain on or off', () => {
  const request = (payload: unknown) =>
    frontendActionRequest({ requestId: 'request:1', actionId: 'action:1', operation: 'setPluginControl', payload })
  expect(request({ id: 'runtime:pacing', value: false }).payload).toEqual({ id: 'runtime:pacing', value: false })
  expect(() => request({ id: 'runtime:pacing', value: 1 })).toThrow()
  expect(() => request({ id: 'runtime:pacing', value: true, extra: 1 })).toThrow()
})
