import { existsSync, mkdirSync, readFileSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync, unlinkSync, rmdirSync, readdirSync, copyFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { worldAddressKey, type WorldAddress } from '@harness-world/contracts'

export interface TailSelection { directory: string; version: string; tail: TailRecord | null }
export interface TailCandidate { id: string; directory: string; headSeq: number; tick: number }
export interface TailRecord {
  id: string; base: string; input: { text: string } | { activity: unknown }
  environment: string; headSeq: number; tick: number; activityRandom: number[]
  candidates?: TailCandidate[]; selected?: string
}
const id = /^[a-f0-9-]{36}$/
export function readTailSelection(root: string): TailSelection | undefined {
  const path = join(root, 'current-world.json')
  if (!existsSync(path)) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8')) as TailSelection
  if (!value || !id.test(value.version) || !(value.directory === '.' || /^\.tail\/results\/[a-f0-9-]{36}$/.test(value.directory))
    || (value.tail !== null && (!id.test(value.tail.id) || !id.test(value.tail.base) || typeof value.tail.environment !== 'string'
      || !Number.isSafeInteger(value.tail.headSeq) || !Number.isSafeInteger(value.tail.tick)
      || !Array.isArray(value.tail.activityRandom) || value.tail.activityRandom.some(n => typeof n !== 'number' || n < 0 || n >= 1)
      || !value.tail.input || Object.keys(value.tail.input).length !== 1
      || !('text' in value.tail.input && typeof value.tail.input.text === 'string' || 'activity' in value.tail.input)))) throw new Error('当前世界记录损坏，拒绝恢复。')
  if (value.tail?.candidates && (!Array.isArray(value.tail.candidates) || !value.tail.candidates.length
    || value.tail.candidates.some(candidate => !candidate || !id.test(candidate.id)
      || !(candidate.directory === '.' || /^\.tail\/results\/[a-f0-9-]{36}$/.test(candidate.directory))
      || !Number.isSafeInteger(candidate.headSeq) || !Number.isSafeInteger(candidate.tick))
    || new Set(value.tail.candidates.map(candidate => candidate.id)).size !== value.tail.candidates.length
    || !value.tail.candidates.some(candidate => candidate.id === value.tail!.selected && candidate.directory === value.directory
      && candidate.headSeq === value.tail!.headSeq && candidate.tick === value.tail!.tick))) throw new Error('末端候选记录损坏，拒绝恢复。')
  const directory = resolve(root, value.directory)
  if (!existsSync(join(directory, 'world.sqlite'))) throw new Error('当前世界文件缺失，拒绝初始化。')
  if (realpathSync(directory) !== directory) throw new Error('当前世界目录不能使用链接。')
  return value
}
export function currentWorldDirectory(root: string): string { return resolve(root, readTailSelection(root)?.directory ?? '.') }
export function durableJson(path: string, value: unknown): void {
  const temporary = path + '.' + randomUUID() + '.tmp'
  const fd = openSync(temporary, 'wx')
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
}
function flush(path: string): void { const fd = openSync(path, 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) } }

/** One owner for the logical storyline, including its isolated candidate. */
export function ownStoryline(root: string): () => void {
  mkdirSync(root, { recursive: true })
  const path = join(root, '.runtime-owner.json'), token = randomUUID()
  const acquiring = join(root, '.runtime-acquiring')
  // Serialize stale-owner reclamation too: two starters must never remove each other's fresh marker.
  try { mkdirSync(acquiring) } catch { throw new Error('另一实例正在取得运行权限，或上次权限初始化未完成。') }
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd) } finally { closeSync(fd) }
      return () => { if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path) }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const prior = JSON.parse(readFileSync(path, 'utf8')) as { pid: number }
      if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0) throw new Error('运行实例记录损坏。')
      try { process.kill(prior.pid, 0) } catch (cause) {
        if (cause instanceof Error && 'code' in cause && cause.code === 'ESRCH') { unlinkSync(path); continue }
        throw new Error('无法验证已有运行实例。')
      }
      throw new Error('同一故事线已有可写运行实例。')
    }
  }
  throw new Error('无法取得故事线运行权限。')
  } finally { rmdirSync(acquiring) }
}

export function assertSettled(directory: string, address: WorldAddress): { headSeq: number; tick: number } {
  const db = new DatabaseSync(join(directory, 'world.sqlite'), { readOnly: true })
  try {
    const key = worldAddressKey(address)
    if (db.prepare(`SELECT 1 FROM round_inbox WHERE address_key=? AND status IN ('pending','claimed')
      UNION ALL SELECT 1 FROM player_input_jobs WHERE address_key=? AND status IN ('received','prepared','dispatch_started','response_received','validated','round_enqueued')
      UNION ALL SELECT 1 FROM world_reaction_cycles WHERE address_key=? AND status <> 'terminal'
      UNION ALL SELECT 1 FROM outbox WHERE address_key=? AND critical=1 AND delivery_status <> 'delivered'
      UNION ALL SELECT 1 FROM writer_leases WHERE address_key=? AND expires_at_ms>? LIMIT 1`).get(key,key,key,key,key,Date.now())) throw new Error('角色处理、必要投递或提交尚未完成。')
    const head = db.prepare('SELECT head_seq,tick FROM heads WHERE address_key=?').get(key) as { head_seq: number; tick: number }
    return { headSeq: head.head_seq, tick: head.tick }
  } finally { db.close() }
}

/** Backups include installed cognition, never live WAL main files or diagnostic traces. */
export async function snapshotTail(directory: string, target: string, address: WorldAddress, aliases: unknown): Promise<void> {
  assertSettled(directory, address)
  mkdirSync(target, { recursive: true })
  const files: string[] = []
  for (const name of ['world.sqlite','session.sqlite','memory.sqlite','context.sqlite']) {
    const path = join(directory,name)
    if (!existsSync(path)) continue
    const db = new DatabaseSync(path,{readOnly:true})
    try { await backup(db,join(target,name)) } finally { db.close() }
    files.push(name)
  }
  if (existsSync(join(directory,'pack-variables.json'))) { copyFileSync(join(directory,'pack-variables.json'),join(target,'pack-variables.json')); files.push('pack-variables.json') }
  durableJson(join(target,'memory-aliases.json'),aliases); files.push('memory-aliases.json')
  const core = join(directory,'memory-core')
  if (existsSync(core)) for (const name of readdirSync(core).filter(n => /^[A-Za-z0-9_-]+\.json$/.test(n))) {
    mkdirSync(join(target,'memory-core'),{recursive:true})
    copyFileSync(join(core,name),join(target,'memory-core',name)); files.push('memory-core/'+name)
  }
  for (const name of files) flush(join(target,name))
  durableJson(join(target,'snapshot.json'),{ files: files.map(name => ({name, digest: createHash('sha256').update(readFileSync(join(target,name))).digest('hex')})) })
}
export function flushTailData(directory: string): void {
  for (const name of ['world.sqlite','session.sqlite','memory.sqlite','context.sqlite','pack-variables.json','memory-aliases.json']) {
    const path = join(directory,name)
    if (existsSync(path)) flush(path)
    if (name.endsWith('.sqlite') && existsSync(path+'-wal')) flush(path+'-wal')
  }
  const core = join(directory,'memory-core')
  if (existsSync(core)) for (const name of readdirSync(core).filter(n=>/^[A-Za-z0-9_-]+\.json$/.test(n))) flush(join(core,name))
}
export function restoreTail(base: string, target: string): void {
  const manifest = JSON.parse(readFileSync(join(base,'snapshot.json'),'utf8')) as { files: {name:string;digest:string}[] }
  if (!manifest.files.some(f => f.name === 'world.sqlite') || !manifest.files.some(f => f.name === 'memory-aliases.json')) throw new Error('回合起点不完整。')
  mkdirSync(target,{recursive:true})
  if (readdirSync(target).length) throw new Error('候选目录必须为空。')
  for (const file of manifest.files) {
    if (!/^(world|session|memory|context)\.sqlite$|^pack-variables\.json$|^memory-aliases\.json$|^memory-core\/[A-Za-z0-9_-]+\.json$/.test(file.name)
      || createHash('sha256').update(readFileSync(join(base,file.name))).digest('hex') !== file.digest) throw new Error('回合起点文件损坏。')
    if (file.name.startsWith('memory-core/')) mkdirSync(join(target,'memory-core'),{recursive:true})
    copyFileSync(join(base,file.name),join(target,file.name))
  }
}
