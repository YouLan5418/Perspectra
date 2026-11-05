import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

// What a witness learns of the player's action must not depend on whether an activity happens to be running.
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const obj = (value: unknown) => value as WorldJsonObject
const COMPANION = 'character:companion',
  FRIEND = 'character:friend',
  BACK = 'location:back-room',
  FRONT = 'location:front-room'

async function world() {
  const root = mkdtempSync(join(tmpdir(), 'immediate-parity-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const packPath = join(root, 'pack')
  cpSync(resolve('examples/world-packs/cross-scene-activity'), packPath, { recursive: true })
  const script = join(packPath, 'scripts/activities/guess.js')
  writeFileSync(script, readFileSync(script, 'utf8').replace('move: false', 'move: true'))
  const server = await startFakeProvider('openai', () => ({ tool: { decision: 'abstain' } }))
  cleanups.push(() => server.close())
  const runtime = await WorldHostRuntime.create({
    packPath,
    dataDirectory: join(root, 'data'),
    models: fakeModels(server.endpoint),
    timeoutMs: 5000,
  })
  cleanups.push(() => runtime.close())
  const events = () => {
    const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
    try {
      return store.readEvents(runtime.address)
    } finally {
      store.close()
    }
  }
  const seenBy = (observerId: string) =>
    events()
      .filter(e => e.eventType === 'observation.upsert')
      .map(e => obj(obj(e.data).value))
      .filter(v => v.observerId === observerId && obj(v.content).actionType === 'move')
      .map(v => obj(v.content))
      .at(-1)
  const lines = () =>
    events()
      .filter(e => e.eventType === 'character.speak')
      .map(e => e.data)
  return { runtime, seenBy, lines }
}
const move = (locationId: string) => `/act move ${JSON.stringify({ locationId })}`

it('an ordinary move tells each witness the part of the route they saw', async () => {
  const f = await world()
  await f.runtime.submit(move(BACK))
  expect(f.seenBy(COMPANION)?.movement).toMatchObject({ fromLocationId: FRONT })
  expect(f.seenBy(FRIEND)?.movement).toMatchObject({ toLocationId: BACK })
})

it('a move during an activity tells witnesses the same route', async () => {
  const f = await world()
  await f.runtime.activityAction({
    activityKey: 'guess',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'parity-start',
  })
  await f.runtime.submit(move(BACK))
  expect(f.seenBy(COMPANION)?.movement).toMatchObject({ fromLocationId: FRONT })
  expect(f.seenBy(FRIEND)?.movement).toMatchObject({ toLocationId: BACK })
})

it('a retried line during an activity is not said twice', async () => {
  const f = await world()
  await f.runtime.activityAction({
    activityKey: 'guess',
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: 'retry-start',
  })
  await f.runtime.submit('我猜五十。', 'retry-line')
  await f.runtime.submit('我猜五十。', 'retry-line')
  expect(f.lines().filter(line => obj(line).text === '我猜五十。')).toHaveLength(1)
})
