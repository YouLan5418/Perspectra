import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brandId, type WorldAddress } from '@harness-world/contracts'
import { SessionDeliveryAdapter, WorldOutbox, WorldStore } from '@harness-world/store-sqlite'
import { compileWorldPackSource, type CompiledWorldPackV5 } from '@harness-world/world-pack'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import { interactionPackageDescription } from '@harness-world/contracts'
import { PlaytestMemoryCore } from '../tests/experiments/playtest-memory-core.ts'
import { PackVariables } from '../tests/experiments/pack-variables.ts'
import { preflightSave } from './save-preflight.ts'
import { readStoryNodes, restoreStoryNode, storyId, type StoryNode } from './story-nodes.ts'

// A bounded JSON container replaces ZIP extraction. Only these literal filenames can be written.
const SHARE_FILES = ['world.sqlite', 'session.sqlite', 'pack-variables.json', 'memory-aliases.json']
const MAX_FILE = 64 * 1024 * 1024, MAX_TOTAL = 96 * 1024 * 1024, MAX_CONTAINER = 129 * 1024 * 1024
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('故事线文件格式无效。')
  return value as Record<string, unknown>
}
function boundedRead(path: string, limit: number): Buffer {
  if (!lstatSync(path).isFile()) throw new Error('故事线文件必须是普通文件。')
  const fd = openSync(path, 'r')
  try {
    if (fstatSync(fd).size > limit) throw new Error('故事线文件超过当前大小限制。')
    const chunks: Buffer[] = []; let total = 0
    while (true) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, limit - total + 1))
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (!count) return Buffer.concat(chunks, total)
      total += count
      if (total > limit) throw new Error('故事线文件超过当前大小限制。')
      chunks.push(chunk.subarray(0, count))
    }
  } finally { closeSync(fd) }
}
function decode(path: string): { node: StoryNode; files: Record<string, Buffer> } {
  let raw: Record<string, unknown>
  try { raw = object(JSON.parse(boundedRead(path, MAX_CONTAINER).toString('utf8'))) }
  catch (error) { if (error instanceof SyntaxError) throw new Error('故事线文件不完整或不是有效 JSON。'); throw error }
  if (raw.kind !== 'perspectra-story-node' || Object.keys(raw).sort().join(',') !== 'files,kind,node') throw new Error('不是支持的单节点故事线文件。')
  const meta = object(raw.node), files = object(raw.files)
  if (Object.keys(meta).sort().join(',') !== 'createdAt,files,headSeq,id,packHash,parentNodeId,tick,title'
    || typeof meta.title !== 'string' || !meta.title.trim() || meta.title.length > 80
    || typeof meta.createdAt !== 'string' || !Number.isFinite(Date.parse(meta.createdAt))
    || typeof meta.packHash !== 'string' || !Number.isSafeInteger(meta.headSeq) || Number(meta.headSeq) < 0
    || !Number.isSafeInteger(meta.tick) || Number(meta.tick) < 0
    || !Array.isArray(meta.files) || !meta.files.includes('world.sqlite') || !meta.files.includes('session.sqlite') || !meta.files.includes('memory-aliases.json')
    || new Set(meta.files).size !== meta.files.length || meta.files.some(name => typeof name !== 'string' || !SHARE_FILES.includes(name))
    || Object.keys(files).sort().join(',') !== [...meta.files].sort().join(',')) throw new Error('故事线节点或文件清单无效。')
  storyId(meta.id); if (meta.parentNodeId !== null) storyId(meta.parentNodeId)
  const decoded: Record<string, Buffer> = {}; let total = 0
  for (const name of meta.files as string[]) {
    const text = files[name]
    if (typeof text !== 'string' || text.length > Math.ceil(MAX_FILE / 3) * 4
      || (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))) throw new Error('故事线文件内容编码无效或过大。')
    const bytes = Buffer.from(text, 'base64'); total += bytes.length
    if (bytes.length > MAX_FILE || total > MAX_TOTAL || bytes.toString('base64') !== text) throw new Error('故事线文件内容过大或编码无效。')
    decoded[name] = bytes
  }
  return { node: meta as unknown as StoryNode, files: decoded }
}
/** Validate a disposable copy, never migrate or write the sender's immutable node. */
async function validate(directory: string, node: StoryNode, packPath: string): Promise<void> {
  for (const name of node.files.filter(name => name.endsWith('.sqlite'))) {
    const db = new DatabaseSync(join(directory, name), { readOnly: true })
    try {
      db.exec('PRAGMA trusted_schema=OFF')
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('故事线数据库损坏。')
    } finally { db.close() }
  }
  if (!node.files.includes('session.sqlite')) throw new Error('分享节点缺少必要的会话文件。')
  const preflight = await preflightSave(packPath, directory)
  if (preflight.packHash !== node.packHash) throw new Error('分享节点与当前游戏包内容不同。')
  const address: WorldAddress = { tenantId: brandId('tenant:web-playtest', 'TenantId'),
    worldId: brandId('world:web-playtest:' + node.packHash.slice(7, 23), 'WorldId'), branchId: brandId('branch:main', 'BranchId') }
  const store = new WorldStore(join(directory, 'world.sqlite'))
  try {
    const report = store.verifyBranchIntegrity(address)
    if (report.headSeq !== node.headSeq || report.tick !== node.tick) throw new Error('分享节点时刻与数据库不一致。')
  } finally { store.close() }
  const session = new SessionDeliveryAdapter(join(directory, 'session.sqlite'))
  try {
    session.verifyIntegrity(address, 'story-share:validate')
    const outbox = new WorldOutbox(join(directory, 'world.sqlite'))
    try {
      const ledger = outbox.deliveryLedger(address, 'story-share:validate')
      const expected = new Map<string, (typeof ledger)[number]>(ledger.map(delivery => [delivery.deliveryId, delivery]))
      const bindings = session.deliveryBindings(), actual = new Map(bindings.map(binding => [binding.deliveryId, binding]))
      if (ledger.some(delivery => delivery.status === 'delivered' && !actual.has(delivery.deliveryId))
        || bindings.some(binding => {
          const delivery = expected.get(binding.deliveryId)
          return !delivery || delivery.sessionId !== binding.sessionId || delivery.sessionDeliverySeq !== binding.sessionDeliverySeq
            || delivery.payloadHash !== binding.payloadHash
        })) throw new Error('分享节点的世界与会话投递不一致。')
    } finally { outbox.close() }
  } finally { session.close() }
  const db = new DatabaseSync(join(directory, 'world.sqlite'), { readOnly: true })
  try {
    if (db.prepare(`SELECT 1 FROM writer_leases WHERE expires_at_ms>? UNION ALL
      SELECT 1 FROM round_inbox WHERE status IN ('pending','claimed') UNION ALL
      SELECT 1 FROM player_input_jobs WHERE status IN ('received','prepared','dispatch_started','response_received','validated','round_enqueued') UNION ALL
      SELECT 1 FROM world_reaction_cycles WHERE status<>'terminal' UNION ALL
      SELECT 1 FROM outbox WHERE critical=1 AND delivery_status<>'delivered' LIMIT 1`).get(Date.now())) throw new Error('分享文件不是完整静止节点。')
  } finally { db.close() }
  const pack = await compileWorldPackSource(packPath, createInstalledInteractionPackages().map(interactionPackageDescription)) as CompiledWorldPackV5
  if (pack.assets.some(asset => asset.path === 'scripts/variables.js') !== node.files.includes('pack-variables.json')) throw new Error('分享节点的包变量文件缺失或不适用。')
  PackVariables.load(packPath, directory, pack)
  const aliases = object(JSON.parse(readFileSync(join(directory, 'memory-aliases.json'), 'utf8')))
  const actors = pack.content.characters.filter(character => character.controllerClass !== 'manual'
    && (character.lifecycle ?? 'active') === 'active').map(character => character.characterId)
  if (Object.keys(aliases).some(actor => !actors.includes(actor as typeof actors[number]))) throw new Error('身份历史包含游戏包之外的角色。')
  const memory = new PlaytestMemoryCore(directory, address, async () => { throw new Error('import must not call a model') })
  try { memory.snapshotAliases(actors) } finally { await memory.close() }
}
export async function exportStoryNode(source: string, nodeId: string, destination: string, packPath: string): Promise<void> {
  if (extname(destination) !== '.perspectra-story') throw new Error('导出文件须使用 .perspectra-story 扩展名。')
  const original = readStoryNodes(source).find(node => node.id === storyId(nodeId))
  if (!original) throw new Error('节点不存在。')
  const node = { ...original, files: original.files.filter(name => SHARE_FILES.includes(name)) }
  const files: Record<string, string> = {}; let total = 0
  for (const name of node.files) { const bytes = boundedRead(join(source, 'story-nodes', node.id, name), MAX_FILE)
    total += bytes.length; if (total > MAX_TOTAL) throw new Error('节点超过当前分享大小限制。'); files[name] = bytes.toString('base64') }
  const temporary = join(dirname(destination), '.' + randomUUID() + '.perspectra-story.tmp')
  const check = temporary + '.check'
  try {
    mkdirSync(check)
    for (const name of node.files) writeFileSync(join(check, name), Buffer.from(files[name]!, 'base64'))
    await validate(check, node, packPath)
    writeFileSync(temporary, JSON.stringify({ kind: 'perspectra-story-node', node, files }), { flag: 'wx' })
    renameSync(temporary, destination)
  } finally {
    rmSync(check, { recursive: true, force: true }); rmSync(temporary, { force: true })
  }
}
/** Returns only after a complete standalone instance directory has been published. Index is caller-owned. */
export async function importStoryNode(path: string, instancesRoot: string, packPath: string, packHash: string): Promise<{ id: string; node: StoryNode }> {
  const shared = decode(path)
  if (shared.node.packHash !== packHash) throw new Error('故事线需要内容完全相同的游戏包；请先载入对应游戏包。')
  const id = randomUUID(), temporary = join(instancesRoot, '.' + id), target = join(instancesRoot, id)
  mkdirSync(temporary, { recursive: true })
  try {
    const node: StoryNode = { ...shared.node, id: randomUUID(), parentNodeId: null }
    const nodeRoot = join(temporary, 'story-nodes', node.id)
    mkdirSync(nodeRoot, { recursive: true })
    for (const name of node.files) writeFileSync(join(nodeRoot, name), shared.files[name]!)
    // The validation copy may run existing migrations; leave the immutable imported node bytes intact.
    const check = join(temporary, '.check'); mkdirSync(check)
    for (const name of node.files) writeFileSync(join(check, name), shared.files[name]!)
    await validate(check, node, packPath)
    rmSync(check, { recursive: true, force: true })
    writeFileSync(join(nodeRoot, 'node.json'), JSON.stringify(node))
    restoreStoryNode(temporary, node.id, join(temporary, '.runtime'), packHash)
    for (const name of [...node.files, 'rebuild-memory.json']) renameSync(join(temporary, '.runtime', name), join(temporary, name))
    rmSync(join(temporary, '.runtime'), { recursive: true })
    renameSync(temporary, target)
    return { id, node }
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error }
}
