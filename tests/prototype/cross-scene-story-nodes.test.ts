import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { restoreStoryNode, readStoryNodes } from '../../desktop/story-nodes.ts'
import { exportStoryNode, importStoryNode } from '../../desktop/story-share.ts'
import { crossSceneRuntime } from '../experiments/cross-scene-runtime.ts'
import { CrossScenePhone } from '../experiments/cross-scene-phone.ts'

const packPath = resolve('examples/world-packs/cross-scene-activity'), friend = 'character:friend', player = 'character:player'
const roots: string[] = [], runtimes: Awaited<ReturnType<typeof crossSceneRuntime>>[] = []
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function open(directory: string, phone: boolean, decide?: Parameters<typeof crossSceneRuntime>[1]) {
  const r = await crossSceneRuntime(directory, decide ?? (async request => {
    const actor = String((request.context.character as WorldJsonObject).characterId)
    if (phone && actor === friend && !request.continuation) {
      const call = (r.communication as CrossScenePhone).callFor(r.store.readEvents(r.address), friend)
      if (call?.state === 'ringing') return { decision: 'perform', actionType: 'interact',
        parameters: (r.communication as CrossScenePhone).phoneParameters('accept', player, call.callId) }
    }
    return { decision: 'abstain' }
  }), { phone, packPath, activities: true, storyNodes: true })
  runtimes.push(r); return r
}
async function close(r: Awaited<ReturnType<typeof open>>) { await r.close(); runtimes.splice(runtimes.indexOf(r), 1) }
async function fixture(phone: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'communication-node-')); roots.push(root)
  let speakRemote = false
  const source = join(root, 'source'), r = await open(source, phone, async request => {
    if (phone && String((request.context.character as WorldJsonObject).characterId) === friend && !request.continuation) {
      const call = (r.communication as CrossScenePhone).callFor(r.store.readEvents(r.address), friend)
      if (call?.state === 'ringing') return { decision: 'perform', actionType: 'interact',
        parameters: (r.communication as CrossScenePhone).phoneParameters('accept', player, call.callId) }
      if (call?.state === 'connected' && speakRemote) return { decision: 'perform', actionType: 'interact',
        parameters: (r.communication as CrossScenePhone).phoneParameters('say', player, call.callId, '远端私密山茶') }
    }
    return { decision: 'abstain' }
  })
  await r.activities!.apply({ activityKey: 'guess', activityId: null, revision: 0, operation: 'start', parameters: {}, requestId: 'start' })
  if (phone) {
    await r.phone('call', undefined, friend); await r.phone('say', '节点前暗号青灯', friend)
    speakRemote = true; await r.activate(friend, { maxCalls: 2 }); speakRemote = false
  }
  else await r.send('节点前暗号青灯', friend)
  const activity = structuredClone(r.activities!.current()), node = await r.saveNode('通信中的节点'), saved = r.store.readEvents(r.address)
  if (phone) { await r.phone('say', '未来暗号鸢尾', friend); await r.phone('hangup', undefined, friend) }
  else await r.send('未来暗号鸢尾', friend)
  await r.activities!.apply({ activityKey: 'guess', activityId: activity!.id, revision: activity!.revision,
    operation: 'guess', parameters: { value: 20 }, requestId: 'future-guess' })
  const future = r.store.readEvents(r.address)
  await close(r)
  return { root, source, node, activity, saved, future }
}

it.each([false, true])('restores communication and activity to the actual saved prefix, keeping the source future (phone=%s)', async phone => {
  const f = await fixture(phone), childDirectory = join(f.root, 'child')
  restoreStoryNode(f.source, f.node.id, childDirectory, f.node.packHash)
  const child = await open(childDirectory, phone)
  expect(child.store.readEvents(child.address)).toEqual(f.saved)
  expect(child.activities!.current()).toEqual(f.activity)
  expect(existsSync(join(childDirectory, 'rebuild-memory.json'))).toBe(false)
  expect(JSON.stringify(child.view(friend).observations)).toContain('节点前暗号青灯')
  expect(JSON.stringify(child.view(friend).observations)).not.toContain('未来暗号鸢尾')
  const headSeq = child.store.head(child.address).headSeq
  expect(JSON.stringify(child.memory.recall(child.address, brandId(friend, 'CharacterId'), '青灯', headSeq))).toContain('青灯')
  expect(JSON.stringify(child.memory.recall(child.address, brandId(friend, 'CharacterId'), '鸢尾', headSeq))).not.toContain('未来暗号鸢尾')
  expect(JSON.stringify(child.view('character:companion').observations)).not.toContain(phone ? '远端私密山茶' : '节点前暗号青灯')
  if (phone) {
    expect((child.communication as CrossScenePhone).callFor(child.store.readEvents(child.address), player)?.state).toBe('connected')
    expect((await child.phone('say', '回退后续话', friend)).sent.status).toBe('accepted')
    await child.phone('hangup', undefined, friend)
    expect((await child.phone('say', '结束后拒绝', friend)).sent.status).toBe('rejected')
  } else expect((await child.send('回退后续信', friend)).sent.status).toBe('accepted')
  const original = await open(f.source, phone)
  expect(original.store.readEvents(original.address)).toEqual(f.future)
  expect(original.activities!.current()!.game.public.guesses).toBe(1)
})

it.each([false, true])('shares only the saved communication prefix, rebuilds native memory and continues independently (phone=%s)', async phone => {
  const f = await fixture(phone), archive = join(f.root, 'node.perspectra-story')
  // These unrelated caches must never become part of the shared snapshot.
  writeFileSync(join(f.source, 'story-nodes', f.node.id, 'context.sqlite'), 'REQUEST-CACHE-SECRET')
  await exportStoryNode(f.source, f.node.id, archive, packPath)
  const shared = JSON.parse(readFileSync(archive, 'utf8')) as { files: Record<string, string> }
  expect(Object.keys(shared.files).sort()).toEqual(['memory-aliases.json', 'session.sqlite', 'world.sqlite'])
  expect(Object.values(shared.files).map(bytes => Buffer.from(bytes, 'base64').toString()).join('')).not.toContain('未来暗号鸢尾')
  const receiverRoot = join(f.root, 'receiver')
  const imported = await importStoryNode(archive, receiverRoot, packPath, f.node.packHash), directory = join(receiverRoot, imported.id)
  expect(imported.node.id).not.toBe(f.node.id); expect(imported.node.parentNodeId).toBeNull()
  expect(existsSync(join(directory, 'memory.sqlite'))).toBe(false)
  const receiver = await open(directory, phone)
  expect(receiver.store.readEvents(receiver.address)).toEqual(f.saved)
  expect(receiver.activities!.current()).toEqual(f.activity)
  expect(JSON.stringify(receiver.view(friend).observations)).toContain('节点前暗号青灯')
  expect(JSON.stringify(receiver.view(friend).observations)).not.toContain('未来暗号鸢尾')
  const headSeq = receiver.store.head(receiver.address).headSeq
  expect(JSON.stringify(receiver.memory.recall(receiver.address, brandId(friend, 'CharacterId'), '青灯', headSeq))).toContain('青灯')
  expect(JSON.stringify(receiver.memory.recall(receiver.address, brandId(friend, 'CharacterId'), '鸢尾', headSeq))).not.toContain('未来暗号鸢尾')
  expect(JSON.stringify(receiver.memory.recall(receiver.address, brandId('character:companion', 'CharacterId'), phone ? '山茶' : '青灯', headSeq)))
    .not.toContain(phone ? '远端私密山茶' : '节点前暗号青灯')
  expect(existsSync(join(directory, 'rebuild-memory.json'))).toBe(false)
  if (phone) expect((await receiver.phone('say', '接收者独立续话', friend)).sent.status).toBe('accepted')
  else expect((await receiver.send('接收者独立续信', friend)).sent.status).toBe('accepted')
  const original = await open(f.source, phone)
  expect(original.store.readEvents(original.address)).toEqual(f.future)
  const receiverAgain = await importStoryNode(archive, receiverRoot, packPath, f.node.packHash)
  expect(receiverAgain.id).not.toBe(imported.id)
  const second = await open(join(receiverRoot, receiverAgain.id), phone)
  expect(second.store.readEvents(second.address)).toEqual(f.saved)
})

it('refuses a node while a model activation is running and publishes no partial selectable node', async () => {
  const root = mkdtempSync(join(tmpdir(), 'communication-node-busy-')); roots.push(root)
  let release!: () => void
  const waiting = new Promise<void>(done => { release = done })
  const r = await open(root, false, async () => { await waiting; return { decision: 'abstain' } })
  const activation = r.activate(friend, { maxCalls: 1 })
  try { await expect(r.saveNode('尚未静止')).rejects.toThrow('等待当前行动'); expect(readStoryNodes(root)).toEqual([]) }
  finally { release(); await activation }
  await r.saveNode('已静止'); expect(readStoryNodes(root)).toHaveLength(1)
})

it('restores and shares an unanswered ringing call without replaying the old activation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'communication-node-ringing-')); roots.push(root)
  const source = join(root, 'source'), r = await open(source, true, async () => ({ decision: 'abstain' }))
  await r.phone('call', undefined, friend)
  const node = await r.saveNode('未接听来电')
  await r.phone('hangup', undefined, friend); await close(r)
  const archive = join(root, 'ringing.perspectra-story'); await exportStoryNode(source, node.id, archive, packPath)
  const imported = await importStoryNode(archive, join(root, 'receiver'), packPath, node.packHash)
  const receiver = await open(join(root, 'receiver', imported.id), true, async () => { throw new Error('must not replay') })
  expect((receiver.communication as CrossScenePhone).callFor(receiver.store.readEvents(receiver.address), player)?.state).toBe('ringing')
  expect((await receiver.phone('say', '未接听不应送达', friend)).sent.status).toBe('rejected')
})

it('retains the rebuild gate and fails without a model call when a restored prefix marker is inconsistent', async () => {
  const f = await fixture(false), target = join(f.root, 'invalid-prefix')
  restoreStoryNode(f.source, f.node.id, target, f.node.packHash)
  writeFileSync(join(target, 'rebuild-memory.json'), JSON.stringify({ packHash: f.node.packHash, headSeq: f.node.headSeq + 1 }))
  await expect(open(target, false, async () => { throw new Error('must not call model') })).rejects.toThrow('恢复前缀不一致')
  expect(existsSync(join(target, 'rebuild-memory.json'))).toBe(true)
})
