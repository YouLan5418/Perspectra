import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { brandId, resolutionAuthority, type WorldJsonObject } from '@harness-world/contracts'
import { crossSceneRuntime } from '../experiments/cross-scene-runtime.ts'
import { CrossScenePhone } from '../experiments/cross-scene-phone.ts'

const player = 'character:player', companion = 'character:companion', friend = 'character:friend'
const roots: string[] = [], runtimes: Awaited<ReturnType<typeof crossSceneRuntime>>[] = []
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture(phone = false, allowed = true, decide: Parameters<typeof crossSceneRuntime>[1] = async () => ({ decision: 'abstain' })) {
  const root = mkdtempSync(join(tmpdir(), 'activity-communication-')); roots.push(root)
  const packPath = join(root, 'pack'); cpSync(resolve('examples/world-packs/cross-scene-activity'), packPath, { recursive: true })
  if (!allowed) {
    const path = join(packPath, 'scripts/activities/guess.js')
    writeFileSync(path, readFileSync(path, 'utf8').replace(/interactions: \[[\s\S]*?\],\s*operations:/u, 'interactions: [], operations:'))
  }
  const r = await crossSceneRuntime(join(root, 'data'), decide, { phone, activities: true, packPath }); runtimes.push(r)
  await r.activities!.apply({ activityKey: 'guess', activityId: null, revision: 0, operation: 'start', parameters: {}, requestId: 'start' })
  return r
}
const perform = (parameters: WorldJsonObject) => ({ decision: 'perform', actionType: 'interact', parameters })
const run = (r: Awaited<ReturnType<typeof crossSceneRuntime>>, id: string) => r.turn.run(brandId(id, 'CharacterId'), { signal: new AbortController().signal, maxCalls: 3 })

it('keeps SMS and the active game independent, then accepts a real game operation at the original revision', async () => {
  let received = false
  const r = await fixture(false, true, async request => {
    const id = String((request.context.character as WorldJsonObject).characterId)
    if (id === friend && !request.continuation) {
      expect(request.context.activity).toBeUndefined()
      expect(JSON.stringify(request.context)).not.toContain('"answer":73')
      return perform(r.communication.parameters(companion, '远端暗号：纸船'))
    }
    if (id === companion && !request.continuation) {
      received = true; expect((request.context.activity as WorldJsonObject).revision).toBe(1)
      return perform(r.communication.parameters(friend, '收到，游戏还在继续。'))
    }
    return { decision: 'abstain' }
  })
  const before = structuredClone(r.activities!.current())
  expect((await run(r, friend)).status).not.toBe('failed')
  // A player's message also runs the existing observation-based chain; no activity scheduler is substituted.
  await r.send('测试', friend)
  expect(received).toBe(true); expect(r.activities!.current()).toEqual(before)
  expect(JSON.stringify(r.view(player).observations)).not.toContain('远端暗号：纸船')
  await r.activities!.apply({ activityKey: 'guess', activityId: before!.id, revision: before!.revision,
    operation: 'guess', parameters: { value: 20 }, requestId: 'guess' })
  expect(r.activities!.current()!.game.turn).toBe(companion)
  expect(r.activities!.current()!.game.public.guesses).toBe(1)
})

it.each([false, true])('blocks direct communication when activity permission is absent (phone=%s), and allows it after suspension', async phone => {
  const r = await fixture(phone, false), before = r.store.head(r.address).headSeq
  await expect(phone ? r.phone('call', undefined, friend) : r.send('禁止发送', friend)).rejects.toThrow('活动期间禁止此交互')
  expect(r.store.head(r.address).headSeq).toBe(before)
  const state = r.activities!.current()!
  await r.activities!.apply({ activityKey: 'guess', activityId: state.id, revision: state.revision,
    operation: 'suspend', parameters: {}, requestId: 'suspend' })
  const result = phone ? await r.phone('call', undefined, friend) : await r.send('暂停后可以发送', friend)
  expect(result.sent.status).toBe('accepted')
  expect(r.activities!.current()!.game.active).toBe(false)
})

it('allows an activity participant to accept and answer a remote call without spending a game turn or exposing game state', async () => {
  let called = false, answered = false, gameTurn = false
  const r = await fixture(true, true, async request => {
    const id = String((request.context.character as WorldJsonObject).characterId), phone = r.communication as CrossScenePhone
    if (id === companion && gameTurn && !request.continuation) {
      const state = r.activities!.current()!
      return perform({ targetRef: { kind: 'character', id: companion }, bindingId: state.id,
        definitionRef: { id: 'activity:guess', version: 1 }, arguments: { activityId: state.id, revision: state.revision, value: 60 } })
    }
    if (id === friend && !called) { called = true; return perform(phone.phoneParameters('call', companion)) }
    if (id === companion && !answered) {
      answered = true; const call = phone.callFor(r.store.readEvents(r.address), companion)!
      return perform(phone.phoneParameters('accept', friend, call.callId))
    }
    if (id === companion && request.continuation && request.canPerform) {
      const call = phone.callFor(r.store.readEvents(r.address), companion)!
      return perform(phone.phoneParameters('say', friend, call.callId, '我在玩游戏，稍后聊。'))
    }
    return { decision: 'abstain' }
  })
  const before = structuredClone(r.activities!.current())
  await run(r, friend); await run(r, companion)
  expect((r.communication as CrossScenePhone).callFor(r.store.readEvents(r.address), companion)?.state).toBe('connected')
  expect(r.activities!.current()).toEqual(before)
  const remote = JSON.stringify(r.view(friend).observations)
  expect(remote).toContain('我在玩游戏，稍后聊'); expect(remote).not.toContain('"activity":')
  expect(remote).not.toContain('"answer":73')
  expect(JSON.stringify(r.view(player).observations)).toContain(`${r.communication.medium}本端`)
  expect(r.view(companion).locationId).toBe('location:front-room')
  await r.activities!.apply({ activityKey: 'guess', activityId: before!.id, revision: before!.revision,
    operation: 'guess', parameters: { value: 20 }, requestId: 'connected-player-guess' })
  gameTurn = true
  await run(r, companion)
  expect(r.activities!.current()!.game.public.guesses).toBe(2)
  expect(r.activities!.current()!.game.turn).toBe(player)
  expect((r.communication as CrossScenePhone).callFor(r.store.readEvents(r.address), companion)?.state).toBe('connected')
})

it('does not turn an incoming SMS into permission to respond during a closed activity', async () => {
  let participantOptions: string[] = []
  const r = await fixture(false, false, async request => {
    const id = String((request.context.character as WorldJsonObject).characterId)
    if (id === friend && !request.continuation) return perform(r.communication.parameters(companion, '收到后可以不回应'))
    if (id === companion) participantOptions = (request.context.affordances as WorldJsonObject[])
      .flatMap(a => a.interactions as WorldJsonObject[] ?? []).map(i => String((i.definitionRef as WorldJsonObject).id))
    return { decision: 'abstain' }
  })
  const before = structuredClone(r.activities!.current())
  await run(r, friend); await run(r, companion)
  expect(JSON.stringify(r.view(companion).observations)).toContain('收到后可以不回应')
  expect(participantOptions).not.toContain('experiment:message')
  expect(r.activities!.current()).toEqual(before)
})

it('receives a call during a closed activity but rejects fabricated acceptance, then allows it when paused', async () => {
  const r = await fixture(true, false, async request => {
    const id = String((request.context.character as WorldJsonObject).characterId)
    if (id === friend && !request.continuation) return perform((r.communication as CrossScenePhone).phoneParameters('call', companion))
    return { decision: 'abstain' }
  })
  await run(r, friend)
  const phone = r.communication as CrossScenePhone, call = phone.callFor(r.store.readEvents(r.address), companion)!
  expect(call.state).toBe('ringing')
  expect(JSON.stringify(r.view(companion).observations)).toContain('收到电话呼叫')
  const context = () => ({ manifest: r.manifest, events: r.store.readEvents(r.address), characterId: companion,
    asOfWorldSeq: r.store.head(r.address).headSeq, actionId: 'accept-test',
    action: { actionType: 'interact', parameters: phone.phoneParameters('accept', friend, call.callId) },
    resolutionAuthority: resolutionAuthority('agent', 'standard') })
  expect(() => r.resolver.resolve(context())).toThrow('活动期间禁止此交互')
  expect(phone.callFor(r.store.readEvents(r.address), companion)?.state).toBe('ringing')
  const state = r.activities!.current()!
  await r.activities!.apply({ activityKey: 'guess', activityId: state.id, revision: state.revision,
    operation: 'suspend', parameters: {}, requestId: 'suspend' })
  expect(r.resolver.resolve(context()).status).toBe('accepted')
})
