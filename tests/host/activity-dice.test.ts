import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ActivityState, WorldJsonObject } from '@perspectra/sdk/contracts'
import { officialDiceProvider } from '@perspectra/plugins/dice'
import type { DiceInstance, SeamProvider } from '@perspectra/sdk'
import { WorldStore } from '@perspectra/core/store'
import { WorldHostRuntime, type WorldHostCore } from '../../apps/host/src/runtime/world-runtime.ts'
import { createRoleplayCore } from '../support/roleplay-runtime.ts'
import { startFakeProvider, fakeModels } from '../support/fake-provider.ts'

const roots: string[] = [],
  runtimes: (WorldHostCore | WorldHostRuntime)[] = [],
  servers: Awaited<ReturnType<typeof startFakeProvider>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'activity-dice-'))
  roots.push(root)
  return root
}
/** The launcher demo's guessing game, whose guess also rolls a d20 into public state. */
function pack(change: (script: string) => string) {
  const path = join(fresh(), 'pack')
  cpSync(resolve('examples/world-packs/launcher-demo'), path, { recursive: true })
  const file = join(path, 'scripts/activity.js')
  writeFileSync(file, change(readFileSync(file, 'utf8')))
  return path
}
const rollInGuess = (script: string) =>
  script.replace("if (operation === 'guess') {", "if (operation === 'guess') { game.public.roll = rollDice('1d20');")
async function start(packPath: string) {
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  const dataDirectory = fresh()
  const runtime = await createRoleplayCore({
    dataDirectory,
    packPath,
    models: fakeModels(server.endpoint),
    serialScheduling: true,
  })
  runtimes.push(runtime)
  const events = () => {
    const store = new WorldStore(join(dataDirectory, 'world.sqlite'))
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  const state = () =>
    (events().findLast(event => event.eventType === 'activity.updated')!.data as WorldJsonObject).state as ActivityState
  const begin = () =>
    runtime.activityAction({ activityId: null, revision: 0, operation: 'start', parameters: {}, requestId: 'start' })
  const guess = () => {
    const current = state()
    return runtime.activityAction({
      activityId: current.id,
      revision: current.revision,
      operation: 'guess',
      parameters: { value: 50 },
      requestId: 'guess',
    })
  }
  return { runtime, events, state, begin, guess }
}

it('rolls recorded dice inside resolve and replays them from the round record', async () => {
  const path = pack(rollInGuess)
  const first = await start(path)
  first.runtime.beginRoundRandom()
  await first.begin()
  await first.guess()
  const record = first.runtime.roundRandom()
  // The start's initialize draws the answer first; the guess's d20 is the next recorded draw.
  expect(record).toHaveLength(2)
  const roll = first.state().game.public.roll as WorldJsonObject
  const face = 1 + Math.floor(record[1]! * 20)
  expect(roll).toEqual({ expression: '1d20', dice: [face], modifier: 0, total: face })
  expect(face).toBeGreaterThanOrEqual(1)
  expect(face).toBeLessThanOrEqual(20)

  const replay = await start(path)
  replay.runtime.beginRoundRandom(record)
  await replay.begin()
  await replay.guess()
  expect(replay.state().game.public.roll).toEqual(roll)
  expect(replay.state().game.internal).toEqual(first.state().game.internal)
  expect(replay.runtime.roundRandom()).toEqual(record)
})

it('has no rollDice outside resolve', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = await start(pack(script => script.replace('policy() {', "policy() { rollDice('d20');")))
  await expect(f.begin()).rejects.toMatchObject({
    name: 'PluginFault',
    pluginId: 'official-activities',
    operation: 'policy',
  })
})

it('commits nothing when an expression is invalid', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const bad = await start(pack(script => rollInGuess(script).replace("rollDice('1d20')", "rollDice('d1')")))
  await bad.begin()
  const started = bad.events()
  await expect(bad.guess()).rejects.toThrow()
  expect(bad.events()).toEqual(started)
})

it('refuses to regenerate a round once the dice plugin has changed', async () => {
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  servers.push(server)
  const identity = { faces: 'plain' }
  const dice: SeamProvider<DiceInstance> = { ...officialDiceProvider, identity }
  const runtime = await WorldHostRuntime.create({
    dataDirectory: fresh(),
    packPath: pack(rollInGuess),
    models: fakeModels(server.endpoint),
    plugins: { dice },
    serialScheduling: true,
  })
  runtimes.push(runtime)
  const started = await runtime.activityAction({
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'start',
  })
  // The same recorded draws would land on other faces under another dice plugin.
  identity.faces = 'weighted'
  await expect(runtime.regenerate(started.tailRound!.id!, 'dice-changed')).rejects.toThrow('环境已改变')
})
