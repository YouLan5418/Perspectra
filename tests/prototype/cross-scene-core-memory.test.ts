import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, basename, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorldJsonObject } from '@harness-world/contracts'
import { restoreStoryNode } from '../../desktop/story-nodes.ts'
import { exportStoryNode, importStoryNode } from '../../desktop/story-share.ts'
import { crossSceneRuntime } from '../experiments/cross-scene-runtime.ts'
import { CrossScenePhone } from '../experiments/cross-scene-phone.ts'
import type { CoreRunner } from '../experiments/hindsight-python.ts'

const packPath = resolve('examples/world-packs/cross-scene-activity'), friend = 'character:friend', player = 'character:player'
const roots: string[] = [], runtimes: Awaited<ReturnType<typeof crossSceneRuntime>>[] = []
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('communication-core-')) throw new Error('unexpected test path')
    rmSync(root, { recursive: true, force: true })
  }
})
// Deterministic bridge verifies host authority/restoration; real Python retrieval is tested separately.
const run: CoreRunner = async input => input.operation === 'build'
  ? { archive: { scope: input.scope!, sources: input.sources!, facts: [], episodes: [], observations: [] },
    index: { scope: input.scope!, units: [], vectors: [] } }
  : { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
async function open(path: string, phone: boolean) {
  const r = await crossSceneRuntime(path, async request => {
    if (phone && (request.context.character as WorldJsonObject).characterId === friend && !request.continuation) {
      const call = (r.communication as CrossScenePhone).callFor(r.store.readEvents(r.address), friend)
      if (call?.state === 'ringing') return { decision: 'perform', actionType: 'interact',
        parameters: (r.communication as CrossScenePhone).phoneParameters('accept', player, call.callId) }
      if (call?.state === 'connected' && JSON.stringify(request.context.stimulus).includes('节点前青灯')) return {
        decision: 'perform', actionType: 'interact',
        parameters: (r.communication as CrossScenePhone).phoneParameters('say', player, call.callId, '远端私密山茶') }
    }
    return { decision: 'abstain' }
  }, { phone, packPath, activities: true, storyNodes: true, memoryCoreRun: run,
    memoryContextBudget: { triggerTokens: 170000, compactTokens: 120000, minimumRecentTokens: 0 } })
  runtimes.push(r); return r
}
async function close(r: Awaited<ReturnType<typeof open>>) { await r.close(); runtimes.splice(runtimes.indexOf(r), 1) }

it.each([false, true])('Core sources stay authorized and node rollback/share preserve their actual prefix (phone=%s)', async phone => {
  const root = mkdtempSync(join(tmpdir(), 'communication-core-')); roots.push(root)
  const sourcePath = join(root, 'source'), r = await open(sourcePath, phone)
  await r.activities!.apply({ activityKey: 'guess', activityId: null, revision: 0, operation: 'start', parameters: {}, requestId: 'start' })
  if (phone) { await r.phone('call', undefined, friend); await r.phone('say', '节点前青灯', friend) }
  else await r.send('节点前青灯', friend)
  await r.refreshMemory()
  const archives = r.memoryCore!.snapshotArchives([friend, 'character:companion'])
  expect(JSON.stringify(archives[friend])).toContain('青灯')
  if (phone) expect(JSON.stringify(archives[friend])).toContain('远端私密山茶')
  expect(JSON.stringify(archives['character:companion'])).not.toContain(phone ? '远端私密山茶' : '青灯')
  const node = await r.saveNode('Core 通信'), prefix = r.store.head(r.address).headSeq
  expect(r.memoryCore!.shortTermAfterSeq(friend)).toBe(prefix)
  if (phone) await r.phone('say', '未来鸢尾', friend)
  else await r.send('未来鸢尾', friend)
  await r.refreshMemory()
  expect(JSON.stringify(r.memoryCore!.snapshotArchives([friend]))).toContain('鸢尾')
  await close(r)
  const childPath = join(root, 'rollback'); restoreStoryNode(sourcePath, node.id, childPath, node.packHash)
  const child = await open(childPath, phone)
  expect(child.memoryCore!.snapshotArchives([friend, 'character:companion'])).toEqual(archives)
  expect(child.memoryCore!.archivePrefix(friend)).toBe(prefix)
  expect(JSON.stringify(child.memoryCore!.snapshotArchives([friend]))).not.toContain('鸢尾')
  const archive = join(root, 'node.perspectra-story'); await exportStoryNode(sourcePath, node.id, archive, packPath)
  expect(Object.keys((JSON.parse(readFileSync(archive, 'utf8')) as { files: object }).files)).not.toContain('core-memory.json')
  const imported = await importStoryNode(archive, join(root, 'receiver'), packPath, node.packHash)
  const receiver = await open(join(root, 'receiver', imported.id), phone)
  expect(receiver.memoryCore!.archivePrefix(friend)).toBe(0)
  await receiver.refreshMemory()
  expect(receiver.memoryCore!.snapshotArchives([friend, 'character:companion'])).toEqual(archives)
  expect(receiver.activities!.current()).toEqual(child.activities!.current())
})
