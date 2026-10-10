import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { resolutionAuthority } from '@harness-world/contracts'
import type { WorldJsonObject } from '@harness-world/contracts'
import { crossSceneRuntime } from '../experiments/cross-scene-runtime.ts'
import { CrossScenePhone, phoneCalls } from '../experiments/cross-scene-phone.ts'

const roots: string[] = [], runtimes: Awaited<ReturnType<typeof crossSceneRuntime>>[] = []
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture(decide: Parameters<typeof crossSceneRuntime>[1] = async () => ({ decision: 'abstain' })) {
  const root = mkdtempSync(join(tmpdir(), 'phone-experiment-')); roots.push(root)
  const r = await crossSceneRuntime(root, decide, { phone: true }); runtimes.push(r)
  return { r, root, phone: r.communication as CrossScenePhone }
}
const player = 'character:player', companion = 'character:companion', friend = 'character:friend'
const perform = (parameters: WorldJsonObject) => ({ decision: 'perform', actionType: 'interact', parameters })

it('requires the callee to accept before speech, refuses caller acceptance and keeps unanswered calls ringing', async () => {
  const { r, phone } = await fixture()
  await r.phone('call'); expect(phone.callFor(r.store.readEvents(r.address), player)?.state).toBe('ringing')
  expect((await r.phone('accept')).sent.status).toBe('rejected')
  expect((await r.phone('say', '未接通秘密')).sent.status).toBe('rejected')
  expect(JSON.stringify(r.view(companion).observations)).not.toContain('未接通秘密')
  expect(JSON.stringify(r.view(friend).observations)).not.toContain('communication')
  expect((await r.phone('call')).sent.status).toBe('rejected')
  await r.phone('hangup'); expect(phone.callFor(r.store.readEvents(r.address), player)).toBeUndefined()
})

it('allows acceptance, bidirectional voice and local chains while hiding the remote voice from bystanders', async () => {
  let answered = false, spoke = false
  const { r, phone } = await fixture(async request => {
    const actor = String((request.context.character as WorldJsonObject).characterId)
    if (actor === companion && !answered) {
      answered = true; const call = phone.callFor(r.store.readEvents(r.address), companion)!
      return perform(phone.phoneParameters('accept', player, call.callId))
    }
    if (actor === companion && !request.continuation && !spoke) {
      spoke = true; const call = phone.callFor(r.store.readEvents(r.address), companion)!
      return perform(phone.phoneParameters('say', player, call.callId, '好，我稍后过去。'))
    }
    if (actor === friend) return { decision: 'publish', segments: [{ type: 'speech', text: '我听到你说要过去。' }] }
    return { decision: 'abstain' }
  })
  await r.phone('call'); expect(phone.callFor(r.store.readEvents(r.address), player)?.state).toBe('connected')
  const result = await r.phone('say', '远端秘密：蓝色纸鹤')
  const friendHistory = JSON.stringify(r.view(friend).observations)
  expect(friendHistory).not.toContain('蓝色纸鹤'); expect(friendHistory).toContain('好，我稍后过去')
  expect(friendHistory).toContain('电话本端'); expect(friendHistory).not.toContain('peerId')
  expect(result.transcript.some(line => line.text === '好，我稍后过去。' && line.speaker.includes('电话'))).toBe(true)
  expect(JSON.stringify(r.view(player).observations)).not.toContain('我听到你说要过去')
  expect(r.view(companion).locationId).toBe('location:back-room')
  await r.phone('hangup')
  const count = r.view(companion).observations.length
  expect((await r.phone('say', '结束后不应送达')).sent.status).toBe('rejected')
  expect(r.view(companion).observations).toHaveLength(count)
})

it('supports a genuine refusal without connecting and gives no session authority to a third role', async () => {
  const { r, phone } = await fixture(async request => {
    if (!request.continuation) {
      const call = phone.callFor(r.store.readEvents(r.address), companion)!
      return perform(phone.phoneParameters('decline', player, call.callId))
    }
    return { decision: 'abstain' }
  })
  await r.phone('call'); const call = phoneCalls(r.store.readEvents(r.address))[0]!
  expect(call.state).toBe('ended')
  const denied = phone.resolve({ manifest: r.manifest, events: r.store.readEvents(r.address), characterId: friend,
    actionId: 'third-role', action: { actionType: 'interact', parameters: phone.phoneParameters('say', player, call.callId, '越权') },
    resolutionAuthority: resolutionAuthority('agent', 'standard') })
  expect(denied.status).toBe('rejected'); expect(JSON.stringify(denied.events)).not.toContain('character.speak')
})

it('rolls back the connection update and ringing observation together', async () => {
  const { r, root } = await fixture(), before = r.store.head(r.address).headSeq
  const db = new DatabaseSync(join(root, 'world.sqlite'))
  try { db.exec("CREATE TRIGGER fail_phone BEFORE INSERT ON events WHEN NEW.event_type='observation.upsert' BEGIN SELECT RAISE(ABORT,'phone transaction failed'); END")
    await expect(r.phone('call')).rejects.toThrow('phone transaction failed')
  } finally { db.exec('DROP TRIGGER fail_phone'); db.close() }
  expect(r.store.head(r.address).headSeq).toBe(before); expect(phoneCalls(r.store.readEvents(r.address))).toEqual([])
})

it('restores a committed connection without replaying unanswered reactions', async () => {
  const { r, root, phone } = await fixture(async request => {
    if (!request.continuation) { const call = phone.callFor(r.store.readEvents(r.address), companion)!
      return perform(phone.phoneParameters('accept', player, call.callId)) }
    return { decision: 'abstain' }
  })
  await r.phone('call'); await r.close(); runtimes.splice(runtimes.indexOf(r), 1)
  const restored = await crossSceneRuntime(root, async () => { throw new Error('must not replay') }, { phone: true }); runtimes.push(restored)
  expect((restored.communication as CrossScenePhone).callFor(restored.store.readEvents(restored.address), player)?.state).toBe('connected')
})
