import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { WorldHostRuntime } from '../../desktop/host/world-runtime.ts'
import { fakeModels, startFakeProvider } from '../support/fake-provider.ts'

const PLAYER = 'character:player',
  COMPANION = 'character:companion',
  FRIEND = 'character:friend'
const THUNDER = '一声闷雷滚过，屋里的灯全灭了。'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const obj = (value: unknown) => value as WorldJsonObject

async function world(fields: string, friendPresent: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'scene-notice-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const packPath = join(root, 'pack')
  cpSync(resolve('examples/world-packs/cross-scene-activity'), packPath, { recursive: true })
  const script = join(packPath, 'scripts/activities/guess.js')
  writeFileSync(
    script,
    readFileSync(script, 'utf8') +
      `\nactivityScript.autoStart = (truth, w, previous) => ({ when: [['还没发生过', previous === null]], ${fields} })\n`,
  )
  if (friendPresent) {
    const characters = join(packPath, 'characters.json'),
      scenes = join(packPath, 'scenes.json')
    writeFileSync(characters, readFileSync(characters, 'utf8').replaceAll('location:back-room', 'location:front-room'))
    const parsed = JSON.parse(readFileSync(scenes, 'utf8'))
    parsed.scenes[0].participantIds.push(FRIEND)
    parsed.scenes = [parsed.scenes[0]]
    writeFileSync(scenes, JSON.stringify(parsed))
  }
  const requests: string[] = []
  const server = await startFakeProvider('openai', call => {
    requests.push(call.userText)
    return { tool: { decision: 'abstain' } }
  })
  cleanups.push(() => server.close())
  const runtime = await WorldHostRuntime.create({
    packPath,
    dataDirectory: join(root, 'data'),
    models: fakeModels(server.endpoint),
    timeoutMs: 5000,
  })
  cleanups.push(() => runtime.close())
  await runtime.submit('有人吗？')
  const store = new WorldStore(join(runtime.dataDirectory, 'world.sqlite'))
  cleanups.push(() => store.close())
  const seen = (observerId: string) =>
    store
      .readEvents(runtime.address)
      .filter(event => event.eventType === 'observation.upsert')
      .map(event => obj(obj(event.data).value))
      .filter(value => value.observerId === observerId)
      .map(value => obj(value.content))
  return { runtime, seen, requests }
}
const told = (contents: readonly WorldJsonObject[]) => contents.filter(content => content.eventNotice === THUNDER)

it('tells participants and bystanders the event, but not those elsewhere', async () => {
  const present = await world(`notice: '轰隆！', sceneNotice: '${THUNDER}'`, true)
  expect(told(present.seen(COMPANION))).toEqual([{ eventNotice: THUNDER }])
  expect(present.seen(COMPANION).map(content => content.resultDescription)).toContain('轮流猜数字开始。')
  expect(told(present.seen(FRIEND))).toEqual([{ eventNotice: THUNDER }])
  const away = await world(`sceneNotice: '${THUNDER}'`, false)
  expect(told(away.seen(COMPANION))).toHaveLength(1)
  expect(told(away.seen(FRIEND))).toEqual([])
  expect(JSON.stringify(away.seen(FRIEND))).not.toContain('闷雷')
})

it('shows the player the notice first, and the scene text when there is no other', async () => {
  const withNotice = await world(`notice: '轰隆！', sceneNotice: '${THUNDER}'`, true)
  expect(withNotice.seen(PLAYER).map(content => content.resultDescription)).toContain('轰隆！')
  expect(JSON.stringify(withNotice.seen(PLAYER))).not.toContain('闷雷')
  const alone = await world(`sceneNotice: '${THUNDER}'`, true)
  expect(alone.seen(PLAYER).map(content => content.resultDescription)).toContain(THUNDER)
})

it('keeps the current result when the author writes no scene text', async () => {
  const f = await world(`notice: '轰隆！'`, true)
  expect(f.seen(COMPANION).filter(content => content.eventNotice !== undefined)).toEqual([])
  expect(f.seen(COMPANION).map(content => content.resultDescription)).toContain('轮流猜数字开始。')
  expect(f.seen(FRIEND).filter(content => JSON.stringify(content).includes('轮流猜数字'))).toEqual([])
})

it('reaches the characters in their next request, not attached to the player', async () => {
  const f = await world(`sceneNotice: '${THUNDER}'`, true)
  await f.runtime.activityAction({
    activityKey: 'guess',
    activityId: String(obj((await f.runtime.state()).activities!.find(a => a.activityKey === 'guess')).id),
    revision: Number(obj((await f.runtime.state()).activities!.find(a => a.activityKey === 'guess')).revision),
    operation: 'pass',
    parameters: {},
    requestId: 'next',
  })
  const request = f.requests.findLast(text => text.includes(THUNDER))
  expect(request).toBeDefined()
  const stimulus = obj(JSON.parse(request!).context).stimulus as unknown as { content: WorldJsonObject }[]
  const line = stimulus.find(item => item.content?.eventNotice === THUNDER)!
  // It reads as something noticed: no actor, so nobody is said to have caused it.
  expect(line.content).toEqual({ eventNotice: THUNDER })
})

it('rejects an empty or overlong scene text', async () => {
  for (const text of ["' '", `'${'长'.repeat(501)}'`]) {
    const f = await world(`sceneNotice: ${text}`, true)
    expect(String(obj(obj(await f.runtime.state()).debug).autoStartError)).toContain('在场提示')
  }
})
