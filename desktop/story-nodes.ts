import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { WorldAddress } from '@harness-world/contracts'
import { worldAddressKey } from '@harness-world/contracts'

export interface StoryNode {
  id: string; title: string; createdAt: string; headSeq: number; tick: number
  packHash: string; parentNodeId: string | null; files: string[]
}
export function storyId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new Error('故事节点或线路不存在。')
  return value
}
const NODE_FILES = ['world.sqlite', 'session.sqlite', 'memory.sqlite', 'context.sqlite', 'pack-variables.json', 'memory-aliases.json'] as const
export function readStoryNodes(directory: string): StoryNode[] {
  const root = join(directory, 'story-nodes')
  if (!existsSync(root)) return []
  return readdirSync(root).filter(id => !id.startsWith('.')).map(id => {
    storyId(id)
    const node = JSON.parse(readFileSync(join(root, id, 'node.json'), 'utf8')) as StoryNode
    if (node.id !== id || typeof node.title !== 'string' || typeof node.createdAt !== 'string'
      || typeof node.packHash !== 'string' || !Number.isSafeInteger(node.headSeq) || node.headSeq < 0
      || !Number.isSafeInteger(node.tick) || node.tick < 0 || !(node.parentNodeId === null || typeof node.parentNodeId === 'string')
      || !Array.isArray(node.files) || !node.files.includes('world.sqlite') || !node.files.includes('memory-aliases.json')
      || new Set(node.files).size !== node.files.length || node.files.some(file=>!(NODE_FILES as readonly string[]).includes(file))) throw new Error('故事节点损坏。')
    return node
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** Caller holds the runtime input gate; all foreground and memory writers have stopped. */
export async function saveStoryNode(directory: string, address: WorldAddress, packHash: string, title: string, aliases: unknown, parentNodeId: string | null = null): Promise<StoryNode> {
  if (!title.trim() || title.length > 80) throw new TypeError('节点名称须为 1 至 80 个字符。')
  const root = join(directory, 'story-nodes'), id = randomUUID()
  mkdirSync(root, { recursive: true })
  const temporary = join(root, '.' + id)
  mkdirSync(temporary)
  const world = new DatabaseSync(join(directory, 'world.sqlite'), { readOnly: true })
  let node: StoryNode
  try {
    const key = worldAddressKey(address)
    const unfinished = world.prepare(`SELECT 1 FROM round_inbox WHERE address_key=? AND status IN ('pending','claimed')
      UNION ALL SELECT 1 FROM player_input_jobs WHERE address_key=? AND status IN ('received','prepared','dispatch_started','response_received','validated','round_enqueued')
      UNION ALL SELECT 1 FROM world_reaction_cycles WHERE address_key=? AND status <> 'terminal'
      UNION ALL SELECT 1 FROM outbox WHERE address_key=? AND critical=1 AND delivery_status <> 'delivered'
      UNION ALL SELECT 1 FROM writer_leases WHERE address_key=? AND expires_at_ms>? LIMIT 1`).get(key, key, key, key, key, Date.now())
    if (unfinished) throw new Error('世界尚未静止，请完成当前输入与角色反应后保存。')
    const head = world.prepare('SELECT head_seq,tick FROM heads WHERE address_key=?').get(key) as {head_seq:number;tick:number} | undefined
    if (!head) throw new Error('世界不存在。')
    const nodes = readStoryNodes(directory)
    node = { id, title: title.trim(), createdAt: new Date().toISOString(), headSeq: head.head_seq, tick: head.tick, packHash, parentNodeId: nodes.at(-1)?.id ?? parentNodeId, files: [] }
    await backup(world, join(temporary, 'world.sqlite'))
  } finally { world.close() }
  for (const name of ['session.sqlite', 'memory.sqlite', 'context.sqlite']) {
    const path = join(directory, name)
    if (!existsSync(path)) continue
    const db = new DatabaseSync(path, { readOnly: true })
    try { await backup(db, join(temporary, name)) } finally { db.close() }
  }
  if (existsSync(join(directory, 'pack-variables.json'))) copyFileSync(join(directory, 'pack-variables.json'), join(temporary, 'pack-variables.json'))
  writeFileSync(join(temporary, 'memory-aliases.json'), JSON.stringify(aliases))
  node.files = NODE_FILES.filter(name=>existsSync(join(temporary,name)))
  writeFileSync(join(temporary, 'node.json'), JSON.stringify(node))
  renameSync(temporary, join(root, id))
  return node
}

/** Restore only this immutable node's files; never copy the source line's current directory. */
export function restoreStoryNode(source: string, nodeId: string, target: string, packHash: string): StoryNode {
  const node = readStoryNodes(source).find(n => n.id === storyId(nodeId))
  if (!node || node.packHash !== packHash) throw new Error('节点不存在或游戏包内容不同。')
  mkdirSync(target, { recursive: true })
  if (readdirSync(target).length) throw new Error('新故事线目录必须为空。')
  const origin = join(source, 'story-nodes', node.id)
  for (const name of node.files) {
    if (!existsSync(join(origin,name))) throw new Error('完整节点文件缺失，拒绝恢复。')
  }
  for (const name of node.files) copyFileSync(join(origin,name),join(target,name))
  writeFileSync(join(target, 'rebuild-memory.json'), JSON.stringify({ headSeq: node.headSeq, packHash }))
  return node
}
