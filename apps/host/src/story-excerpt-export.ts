import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { dirname, extname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import {
  existsSync,
  statSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs'
import type { CompiledWorldManifest } from '@perspectra/sdk/contracts'
import { readTailSelection } from './tail-storage.ts'
import { readStoryNodes, storyId } from './story-nodes.ts'
import {
  excerptRoundStarts,
  projectExcerpt,
  excerptMarkdown,
  type ExcerptEvent,
  type StoryExcerpt,
} from './story-excerpt.ts'

interface Line {
  id: string
  parentNodeId?: string | null
  parentStorylineId?: string | null
}
export interface ExcerptOptions {
  rounds?: number
  nodeId?: string
  perspective?: 'player' | 'world'
  expectedLine?: string
}
function target(root: string, id: string) {
  const index = JSON.parse(readFileSync(join(root, 'launcher.json'), 'utf8')) as {
    instances: { id: string; packHash: string; currentStorylineId?: string; storylines?: Line[] }[]
  }
  storyId(id)
  const rows = index.instances.filter(i => i.id === id)
  const instance = rows[0]
  if (rows.length !== 1 || !instance) throw new TypeError('找不到唯一的实例。')
  const lineId = instance.currentStorylineId ?? 'main',
    lines = instance.storylines ?? [{ id: 'main' }]
  if (lines.filter(l => l.id === lineId).length !== 1) throw new TypeError('当前故事线无效。')
  const directory = (line: string) =>
    line === 'main' ? join(root, 'instances', id) : join(root, 'instances', id, 'storylines', storyId(line))
  const logical = directory(lineId)
  const selection = readTailSelection(logical)
  return {
    lineId,
    logical,
    lines,
    directory,
    packHash: instance.packHash,
    selection,
    database: join(logical, selection?.directory ?? '.', 'world.sqlite'),
  }
}
// Without an existing WAL index, even SQLite's readOnly flag can create sidecars. Read a
// checkpointed file without sidecars and verify it stayed checkpointed through the read.
function withSnapshot<T>(path: string, read: (db: DatabaseSync) => T): T {
  if (realpathSync(path) !== resolve(path)) throw new TypeError('不能通过链接选择存档。')
  const wal = path + '-wal',
    shared = path + '-shm'
  const checkpointed = !existsSync(wal)
  if (existsSync(path + '-journal') || (!checkpointed && !existsSync(shared)))
    throw new TypeError('存档正在切换日志，请稍后重试。')
  const stamp = () => {
    const s = statSync(path, { bigint: true })
    return [s.dev, s.ino, s.size, s.ctimeNs, s.mtimeNs].join('/')
  }
  const before = checkpointed ? stamp() : null
  const uri = pathToFileURL(path)
  if (checkpointed) uri.searchParams.set('immutable', '1')
  const db = new DatabaseSync(uri.href, { readOnly: true })
  try {
    db.exec('BEGIN')
    const result = read(db)
    if (checkpointed && (existsSync(wal) || existsSync(path + '-journal') || stamp() !== before))
      throw new TypeError('读取期间存档发生变化，请重试。')
    return result
  } finally {
    db.close()
  }
}
function head(db: DatabaseSync) {
  const rows = db
    .prepare(
      'SELECT h.address_key,h.head_seq,h.event_hash,m.manifest_json,b.parent_address_key FROM heads h JOIN branches b USING(address_key) JOIN branch_activations a USING(address_key) JOIN world_manifests m USING(manifest_hash)',
    )
    .all()
  if (rows.length !== 1 || rows[0]!.parent_address_key !== null) throw new TypeError('存档没有唯一可核对的 Host 分支。')
  const r = rows[0]!
  return {
    key: String(r.address_key),
    seq: Number(r.head_seq),
    hash: String(r.event_hash),
    manifest: JSON.parse(String(r.manifest_json)) as CompiledWorldManifest,
  }
}
function nodeBoundary(t: ReturnType<typeof target>, id: string, db: DatabaseSync, h: ReturnType<typeof head>) {
  storyId(id)
  // A child may fork from a grandparent node without owning a copy of that node.
  const lineage = new Map<string, { directory: string; node: ReturnType<typeof readStoryNodes>[number] }>()
  const visited = new Set<string>()
  let line: Line | undefined = t.lines.find(l => l.id === t.lineId)
  let tip: string | null = null
  while (line) {
    if (visited.has(line.id)) throw new TypeError('故事线路循环。')
    visited.add(line.id)
    const directory = t.directory(line.id)
    const nodes = readStoryNodes(directory)
    if (line.id === t.lineId) tip = nodes.at(-1)?.id ?? line.parentNodeId ?? null
    for (const node of nodes) {
      if (lineage.has(node.id)) throw new TypeError('故事节点身份重复。')
      lineage.set(node.id, { directory, node })
    }
    const parentId: string | null = line.parentStorylineId ?? null
    line = t.lines.find(l => l.id === parentId)
  }
  const seen = new Set<string>()
  while (tip && !seen.has(tip)) {
    seen.add(tip)
    const saved = lineage.get(tip)
    if (!saved) break
    if (tip === id) {
      const anchor = withSnapshot(join(saved.directory, 'story-nodes', id, 'world.sqlite'), head)
      const row = db.prepare('SELECT event_hash FROM events WHERE address_key=? AND seq=?').get(h.key, anchor.seq)
      if (
        saved.node.packHash !== t.packHash ||
        anchor.manifest.contentPack?.packHash !== t.packHash ||
        anchor.key !== h.key ||
        anchor.seq !== saved.node.headSeq ||
        anchor.seq > h.seq ||
        anchor.hash !== row?.event_hash
      )
        throw new TypeError('该节点与所选候选的已提交前缀不一致。')
      return anchor.seq
    }
    tip = saved.node.parentNodeId
  }
  throw new TypeError('请选择当前故事线可追溯的节点。')
}
export function readStoryExcerpt(root: string, instanceId: string, options: ExcerptOptions = {}): StoryExcerpt {
  const perspective = options.perspective ?? 'player',
    rounds = options.rounds ?? 20
  if (
    !['player', 'world'].includes(perspective) ||
    !Number.isSafeInteger(rounds) ||
    rounds < 1 ||
    (options.nodeId !== undefined && options.rounds !== undefined)
  )
    throw new TypeError('请选择正整数回合数或单个故事节点，以及有效视角。')
  root = realpathSync(root)
  const t = target(root, instanceId)
  if (options.expectedLine !== undefined && t.lineId !== options.expectedLine)
    throw new TypeError('当前故事线已改变，请重新选择。')
  return withSnapshot(t.database, db => {
    const h = head(db),
      manifest = h.manifest
    if (manifest.contentPack?.packHash !== t.packHash || manifest.playerBindings.length !== 1)
      throw new TypeError('包身份或玩家绑定无法唯一核对。')
    const events: ExcerptEvent[] = db
      // Keep transaction boundaries even for omitted events. In particular, do not load
      // third-party observation bodies, raw player submissions or proposal payloads.
      .prepare(
        `SELECT seq,transaction_id,event_type,CASE
        WHEN event_type='observation.upsert' AND json_extract(data_json,'$.value.observerId')=? THEN data_json
        WHEN event_type IN ('action.resolved','activity.updated','status.updated')
          OR event_type GLOB 'scene.*' OR event_type GLOB 'visibility.*' OR event_type IN
          ('character.upsert','character.created','character.moved','character.lifecycle-changed') THEN data_json
        ELSE '{}' END AS data_json
        FROM events WHERE address_key=? AND seq<=? ORDER BY seq`,
      )
      .all(manifest.playerBindings[0]!.characterId, h.key, h.seq)
      .map(r => ({
        seq: Number(r.seq),
        transactionId: String(r.transaction_id),
        eventType: String(r.event_type),
        data: JSON.parse(String(r.data_json)),
      }))
    const starts =
      options.nodeId === undefined
        ? excerptRoundStarts(events, t.selection?.tail === null && existsSync(join(t.logical, '.runtime-owner.json')))
        : []
    const afterSeq =
      options.nodeId === undefined
        ? (starts.at(-Math.min(rounds, starts.length)) ?? h.seq + 1) - 1
        : nodeBoundary(t, options.nodeId, db, h)
    const occurrences = new Map<number, number>()
    if (perspective === 'world') {
      for (const r of db
        .prepare(
          `SELECT e.seq,json_array_length(a.authority_json,'$.occurrences') AS n FROM events e JOIN round_authority a ON a.transaction_id=e.transaction_id AND a.address_key=e.address_key WHERE e.address_key=? AND e.seq>? AND e.seq<=? AND e.event_type='world.tick-advanced' AND json_extract(a.authority_json,'$.source')='host.world-events/v1' AND json_extract(a.authority_json,'$.packId')=?`,
        )
        .all(h.key, afterSeq, h.seq, manifest.contentPack.packId))
        if (Number(r.n) > 0) occurrences.set(Number(r.seq), Number(r.n))
    }
    const result = projectExcerpt(events, manifest, afterSeq, perspective, occurrences)
    const latest = target(root, instanceId)
    if (
      latest.lineId !== t.lineId ||
      latest.selection?.version !== t.selection?.version ||
      latest.selection?.tail?.id !== t.selection?.tail?.id ||
      latest.selection?.tail?.selected !== t.selection?.tail?.selected ||
      latest.database !== t.database ||
      latest.packHash !== t.packHash
    )
      throw new TypeError('读取期间所选故事线或候选发生变化，请重试。')
    return {
      schemaVersion: 'story-excerpt/v1',
      title: manifest.metadata.title,
      perspective,
      range: {
        instanceId,
        lineId: t.lineId,
        afterSeq,
        headSeq: h.seq,
        headHash: h.hash,
        candidateId: t.selection?.tail?.selected ?? t.selection?.tail?.id ?? null,
        ...(options.nodeId === undefined
          ? { requestedRounds: rounds, includedRounds: Math.min(rounds, starts.length) }
          : { nodeId: options.nodeId }),
      },
      ...result,
    }
  })
}
export function exportStoryExcerpt(root: string, id: string, path: string, options: ExcerptOptions = {}) {
  const ext = extname(path).toLowerCase()
  if (ext !== '.json' && ext !== '.md') throw new TypeError('输出文件须为新的 .json 或 .md。')
  const dir = relative(realpathSync(root), realpathSync(dirname(resolve(path))))
  if (!isAbsolute(dir) && dir !== '..' && !dir.startsWith('..' + sep))
    throw new TypeError('请把片段保存到 Launcher 数据目录之外。')
  const excerpt = readStoryExcerpt(root, id, options)
  const data = ext === '.json' ? JSON.stringify(excerpt, null, 2) + '\n' : excerptMarkdown(excerpt)
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new TypeError('文件已经存在，请选一个新文件名。')
    throw err
  }
  try {
    writeFileSync(fd, data, 'utf8')
  } catch (e) {
    closeSync(fd)
    unlinkSync(path)
    throw e
  }
  closeSync(fd)
  return { command: 'excerpt', format: ext.slice(1), range: excerpt.range, materials: excerpt.materials.length }
}
