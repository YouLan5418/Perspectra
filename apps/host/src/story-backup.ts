import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  assembleRoleplay,
  CORE_MEMORY_ID,
  officialMemoryNoneProvider,
  type WorldComposition,
} from './official-bundle.ts'
import { readPluginSet } from './runtime/plugin-set.ts'
import { readStoryNodes, restoreStoryNode, storyId, type StoryNode } from './story-nodes.ts'
import { validateStorySnapshot } from './story-share.ts'

export interface BackupLine {
  id: string
  name: string
  parentStorylineId: string | null
  parentNodeId: string | null
}
export interface BackupTree {
  name: string
  packHash: string
  currentStorylineId: string
  storylines: BackupLine[]
}
interface NodeEntry {
  lineId: string
  node: StoryNode
  objects: Record<string, string>
}
interface Backup {
  kind: 'perspectra-save-tree'
  version: 1
  tree: BackupTree
  nodes: NodeEntry[]
  objects: { hash: string; size: number; data: string }[]
}
// Bounded, standalone JSON container. No paths from the archive are extracted.
const FILES = ['world.sqlite', 'session.sqlite', 'memory-aliases.json', 'core-memory.json', 'plugin-set.json']
const MAX_FILE = 64 * 1024 * 1024,
  MAX_TOTAL = 192 * 1024 * 1024,
  MAX_CONTAINER = 260 * 1024 * 1024
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function fail(): never {
  throw new Error('整树备份格式、引用或线路关系无效。')
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
function keys(value: object, names: string[]) {
  if (Object.keys(value).sort().join(',') !== names.sort().join(',')) fail()
}
function label(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) fail()
}
function lineId(value: unknown): string {
  return value === 'main' ? value : storyId(value)
}
function regular(path: string, limit: number): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('备份文件不是普通文件或超过体积上限。')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > limit) throw new Error('备份文件超过体积上限。')
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, limit - total + 1))
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (!count) return Buffer.concat(chunks, total)
      total += count
      if (total > limit) throw new Error('备份文件超过体积上限。')
      chunks.push(chunk.subarray(0, count))
    }
  } finally {
    closeSync(fd)
  }
}
function directory(path: string) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('备份目录不得使用链接。')
}
export const backupLineDirectory = (root: string, id: string): string =>
  id === 'main' ? root : join(root, 'storylines', storyId(id))
function validateManifest(raw: unknown): Backup {
  const b = record(raw)
  keys(b, ['kind', 'version', 'tree', 'nodes', 'objects'])
  if (b.kind !== 'perspectra-save-tree' || b.version !== 1) throw new Error('不支持此整树备份版本。')
  const tree = record(b.tree)
  keys(tree, ['name', 'packHash', 'currentStorylineId', 'storylines'])
  label(tree.name)
  if (typeof tree.packHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(tree.packHash)) fail()
  if (
    !Array.isArray(tree.storylines) ||
    !tree.storylines.length ||
    tree.storylines.length > 64 ||
    !Array.isArray(b.nodes) ||
    !b.nodes.length ||
    b.nodes.length > 256 ||
    !Array.isArray(b.objects) ||
    b.objects.length > 1280
  )
    fail()
  const lines = new Map<string, BackupLine>()
  for (const value of tree.storylines) {
    const l = record(value)
    keys(l, ['id', 'name', 'parentStorylineId', 'parentNodeId'])
    const id = lineId(l.id)
    label(l.name)
    if (lines.has(id)) fail()
    if (
      id === 'main'
        ? l.parentStorylineId !== null || l.parentNodeId !== null
        : l.parentStorylineId === null || l.parentNodeId === null
    )
      fail()
    if (l.parentStorylineId !== null) lineId(l.parentStorylineId)
    if (l.parentNodeId !== null) storyId(l.parentNodeId)
    lines.set(id, l as unknown as BackupLine)
  }
  if (!lines.has('main') || !lines.has(lineId(tree.currentStorylineId))) fail()
  const nodes = new Map<string, NodeEntry>()
  for (const value of b.nodes) {
    const entry = record(value),
      n = record(entry.node),
      refs = record(entry.objects)
    keys(entry, ['lineId', 'node', 'objects'])
    keys(n, [
      'id',
      'title',
      'createdAt',
      'headSeq',
      'tick',
      'packHash',
      'parentNodeId',
      'files',
      'memoryProvider',
      ...(n.noticeCursor === undefined ? [] : ['noticeCursor']),
    ])
    storyId(n.id)
    if (n.parentNodeId !== null) storyId(n.parentNodeId)
    label(n.title)
    if (
      !lines.has(String(entry.lineId)) ||
      nodes.has(String(n.id)) ||
      n.packHash !== tree.packHash ||
      typeof n.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(n.createdAt)) ||
      !Number.isSafeInteger(n.headSeq) ||
      Number(n.headSeq) < 0 ||
      !Number.isSafeInteger(n.tick) ||
      Number(n.tick) < 0 ||
      typeof n.memoryProvider !== 'string' ||
      !Array.isArray(n.files) ||
      n.files.length !== FILES.length ||
      [...n.files].sort().join(',') !== [...FILES].sort().join(',')
    )
      fail()
    keys(refs, [...FILES])
    if (Object.values(refs).some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))) fail()
    nodes.set(String(n.id), entry as unknown as NodeEntry)
  }
  const own = (id: string) =>
    [...nodes.values()]
      .filter(e => e.lineId === id)
      .sort((a, b) => a.node.createdAt.localeCompare(b.node.createdAt) || a.node.id.localeCompare(b.node.id))
  const head = (id: string) => own(id).at(-1)?.node.id ?? lines.get(id)!.parentNodeId
  function ancestry(start: string | null): Set<string> {
    const seen = new Set<string>()
    while (start) {
      if (seen.has(start) || !nodes.has(start)) fail()
      seen.add(start)
      start = nodes.get(start)!.node.parentNodeId
    }
    return seen
  }
  for (const line of lines.values()) {
    const seen = new Set<string>()
    let p: BackupLine | undefined = line
    while (p) {
      if (seen.has(p.id)) fail()
      seen.add(p.id)
      if (p.parentStorylineId === null) break
      p = lines.get(p.parentStorylineId)
      if (!p) fail()
    }
    if (line.parentStorylineId !== null && !ancestry(head(line.parentStorylineId)).has(line.parentNodeId!)) fail()
    let previous = line.parentNodeId
    for (const entry of own(line.id)) {
      if (entry.node.parentNodeId !== previous) fail()
      previous = entry.node.id
    }
    if (!head(line.id)) throw new Error('主线路尚无已保存节点；请先保存进度。')
    ancestry(head(line.id))
  }
  return raw as Backup
}
function decodeObjects(b: Backup): Map<string, Buffer> {
  const objects = new Map<string, Buffer>()
  let total = 0
  for (const value of b.objects) {
    const o = record(value)
    keys(o, ['hash', 'size', 'data'])
    if (
      typeof o.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(o.hash) ||
      objects.has(o.hash) ||
      !Number.isSafeInteger(o.size) ||
      Number(o.size) < 0 ||
      Number(o.size) > MAX_FILE ||
      typeof o.data !== 'string' ||
      o.data.length > Math.ceil(MAX_FILE / 3) * 4
    )
      fail()
    const bytes = Buffer.from(o.data, 'base64')
    total += bytes.length
    if (bytes.length !== o.size || bytes.toString('base64') !== o.data || hash(bytes) !== o.hash || total > MAX_TOTAL)
      throw new Error('备份对象哈希、尺寸或总量校验失败。')
    objects.set(o.hash, bytes)
  }
  const expanded = b.nodes.reduce(
    (sum, entry) => sum + Object.values(entry.objects).reduce((n, h) => n + (objects.get(h)?.length ?? 0), 0),
    0,
  )
  if (expanded > 512 * 1024 * 1024) throw new Error('备份展开节点总量超过 512 MiB 上限。')
  const referenced = new Set(b.nodes.flatMap(e => Object.values(e.objects)))
  if (referenced.size !== objects.size || [...referenced].some(h => !objects.has(h)))
    throw new Error('备份缺少对象或含未引用对象。')
  return objects
}
/** Validate immutable snapshots on disposable copies; never open a runtime or build memories. */
async function validateNodes(
  b: Backup,
  objects: Map<string, Buffer>,
  check: string,
  packPath: string,
  composition: WorldComposition,
) {
  const prefixes = new Map<string, { full: string; parent: string }>()
  const nodes = new Map(b.nodes.map(e => [e.node.id, e.node]))
  for (const entry of b.nodes) {
    const path = join(check, entry.node.id)
    mkdirSync(path, { recursive: true })
    for (const file of FILES) writeFileSync(join(path, file), objects.get(entry.objects[file]!)!)
    const plugins = readPluginSet(path)
    const provider = entry.node.memoryProvider
    const memory = plugins?.seams.memory
    // These two official archive contracts have a model-free importer. Unknown providers fail closed.
    if (
      ![CORE_MEMORY_ID, officialMemoryNoneProvider.id].includes(provider!) ||
      memory?.length !== 1 ||
      memory[0]!.id !== provider ||
      memory[0]!.version !== '1.0.0'
    )
      throw new Error('备份记忆提供者或档案版本不兼容。')
    if (
      provider === officialMemoryNoneProvider.id &&
      Object.keys(record(JSON.parse(readFileSync(join(path, 'core-memory.json'), 'utf8')))).length
    )
      throw new Error('无长期记忆提供者不得携带长期档案。')
    const ancestor = entry.node.parentNodeId ? nodes.get(entry.node.parentNodeId) : undefined
    await validateStorySnapshot(path, entry.node, packPath, composition, ancestor)
    const db = new DatabaseSync(join(path, 'world.sqlite'), { readOnly: true })
    try {
      const full = createHash('sha256'),
        parent = createHash('sha256')
      const cutoff = ancestor?.headSeq ?? 0
      for (const row of db.prepare('SELECT * FROM events ORDER BY seq').iterate()) {
        const bytes = JSON.stringify(row) + '\n'
        full.update(bytes)
        if (Number(row.seq) <= cutoff) parent.update(bytes)
      }
      prefixes.set(entry.node.id, { full: full.digest('hex'), parent: parent.digest('hex') })
    } finally {
      db.close()
    }
    rmSync(path, { recursive: true })
  }
  for (const { node } of b.nodes) {
    if (!node.parentNodeId) continue
    const parent = prefixes.get(node.parentNodeId)!,
      current = prefixes.get(node.id)!
    if (nodes.get(node.parentNodeId)!.headSeq > node.headSeq || parent.full !== current.parent)
      throw new Error('节点祖先与实际世界事实前缀不一致。')
  }
}
export async function exportStoryTree(
  source: string,
  tree: BackupTree,
  destination: string,
  packPath: string,
  composition = assembleRoleplay(),
): Promise<void> {
  if (extname(destination) !== '.perspectra-backup') throw new Error('整树备份须使用 .perspectra-backup 扩展名。')
  if (existsSync(destination)) throw new Error('目标文件已存在，请选择新文件名。')
  directory(source)
  if (!tree.storylines.length || tree.storylines.length > 64) fail()
  const objects = new Map<string, Buffer>()
  const nodes: NodeEntry[] = []
  let total = 0
  for (const line of tree.storylines) {
    const path = backupLineDirectory(source, line.id)
    directory(path)
    if (line.id !== 'main') directory(join(source, 'storylines'))
    if (!existsSync(join(path, 'story-nodes'))) continue
    directory(join(path, 'story-nodes'))
    const entries = readdirSync(join(path, 'story-nodes')).filter(id => !id.startsWith('.'))
    if (nodes.length + entries.length > 256) throw new Error('备份超过 256 个节点上限。')
    for (const id of entries) {
      storyId(id)
      directory(join(path, 'story-nodes', id))
      regular(join(path, 'story-nodes', id, 'node.json'), 64 * 1024)
    }
    for (const original of readStoryNodes(path)) {
      if (FILES.some(file => !original.files.includes(file))) throw new Error('保存节点缺少完整备份文件清单。')
      const root = join(path, 'story-nodes', original.id)
      directory(root)
      regular(join(root, 'node.json'), 64 * 1024)
      const entry: NodeEntry = { lineId: line.id, node: { ...original, files: [...FILES] }, objects: {} }
      for (const file of FILES) {
        const bytes = regular(join(root, file), MAX_FILE),
          h = hash(bytes)
        if (!objects.has(h)) {
          total += bytes.length
          objects.set(h, bytes)
        }
        if (total > MAX_TOTAL) throw new Error('备份去重后超过 192 MiB 上限。')
        entry.objects[file] = h
      }
      nodes.push(entry)
    }
  }
  const b: Backup = { kind: 'perspectra-save-tree', version: 1, tree, nodes, objects: [] }
  validateManifest(b)
  const temporary = join(dirname(destination), '.' + randomUUID() + '.backup-tmp'),
    check = temporary + '.check'
  try {
    await validateNodes(b, objects, check, packPath, composition)
    b.objects = [...objects].map(([hash, bytes]) => ({ hash, size: bytes.length, data: bytes.toString('base64') }))
    decodeObjects(b) // Apply the same expansion limits before publishing an export.
    const json = JSON.stringify(b)
    if (Buffer.byteLength(json) > MAX_CONTAINER) throw new Error('备份容器超过体积上限。')
    writeFileSync(temporary, json, { flag: 'wx' })
    linkSync(temporary, destination) // atomic publish, no overwrite, same directory/filesystem
  } finally {
    rmSync(check, { recursive: true, force: true })
    rmSync(temporary, { force: true })
  }
}
export async function importStoryTree(
  path: string,
  instancesRoot: string,
  packPath: string,
  packHash: string,
  composition = assembleRoleplay(),
): Promise<{ id: string; tree: BackupTree }> {
  let raw: unknown
  try {
    raw = JSON.parse(regular(path, MAX_CONTAINER).toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('备份文件不完整或不是有效 JSON。')
    throw error
  }
  const b = validateManifest(raw)
  if (b.tree.packHash !== packHash) throw new Error('备份需要内容完全相同的游戏包；请先载入对应游戏包。')
  const objects = decodeObjects(b),
    id = randomUUID(),
    temporary = join(instancesRoot, '.' + id),
    target = join(instancesRoot, id)
  mkdirSync(temporary, { recursive: true })
  try {
    await validateNodes(b, objects, join(temporary, '.check'), packPath, composition)
    rmSync(join(temporary, '.check'), { recursive: true })
    for (const entry of b.nodes) {
      const nodeRoot = join(backupLineDirectory(temporary, entry.lineId), 'story-nodes', entry.node.id)
      mkdirSync(nodeRoot, { recursive: true })
      for (const file of FILES) writeFileSync(join(nodeRoot, file), objects.get(entry.objects[file]!)!)
      writeFileSync(join(nodeRoot, 'node.json'), JSON.stringify(entry.node))
    }
    for (const line of b.tree.storylines) {
      const lineRoot = backupLineDirectory(temporary, line.id)
      const own = readStoryNodes(lineRoot),
        head = own.at(-1)?.id ?? line.parentNodeId!
      const owner = b.nodes.find(e => e.node.id === head)!
      const staging = join(temporary, '.restore-' + line.id)
      restoreStoryNode(backupLineDirectory(temporary, owner.lineId), head, staging, packHash)
      mkdirSync(lineRoot, { recursive: true })
      for (const file of [...FILES, 'rebuild-memory.json'])
        copyFileSync(join(staging, file), join(lineRoot, file), constants.COPYFILE_EXCL)
      rmSync(staging, { recursive: true })
    }
    renameSync(temporary, target)
    return { id, tree: b.tree }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}
