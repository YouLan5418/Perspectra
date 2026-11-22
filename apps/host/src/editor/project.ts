import { checkKnowledgeActivities } from './knowledge.ts'
import { EditConflict } from './edit-conflict.ts'
export { EditConflict } from './edit-conflict.ts'
import { scriptEntries } from './adjudication-files.ts'
import { rulingTargets } from '@perspectra/world-pack/editor-fields'
import { validateRuling } from './adjudication.ts'
import { ruleCatalog } from './rule-source.ts'
import { variableCandidates, acceptsVariableValue } from '@perspectra/world-pack/editor-fields'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  parseWorldPackCharactersSourceV3,
  parseWorldPackEntitiesSourceV2,
  parseWorldPackLocationsSource,
  parseWorldPackScenesSourceV2,
  parseWorldPackSourceManifestV5,
} from '@perspectra/world-pack'
import { activityScriptPath } from '../runtime/activity-source.ts'
import { conditionReferences, editorKey, generatedActivity, parseGraph, type EditorGraph } from './activity-graph.ts'

export const layoutFolder = 'creator-layouts'
export const draftFolder = 'creator-activities'
export const manifestFile = 'worldpack.source.json'
/** Each existing path component must live in this source tree; the final component may be a new file. */
export function packPath(root: string, name: string): string {
  if (
    isAbsolute(name) ||
    name.includes('\\') ||
    name.includes(':') ||
    name.split('/').some(s => !s || s === '..' || s === '.')
  )
    throw new TypeError('无效的包内路径：' + name)
  let path = root
  for (const part of name.split('/')) {
    path = join(path, part)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink() || (stat && relative(root, realpathSync(path)) !== relative(root, path)))
      throw new TypeError('包内路径经过链接：' + name)
  }
  return path
}
export function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
function json(root: string, path: string): unknown {
  return JSON.parse(readFileSync(packPath(root, path), 'utf8'))
}
export function manifest(root: string) {
  return parseWorldPackSourceManifestV5(json(root, manifestFile))
}
export function readProject(source: string) {
  const root = realpathSync(source),
    m = manifest(root)
  const characters = m.characterFiles.flatMap(file =>
    parseWorldPackCharactersSourceV3(json(root, file), file).characters.map(c => ({
      id: c.characterId,
      name: c.displayName,
    })),
  )
  const items = m.entityFiles.flatMap(file =>
    parseWorldPackEntitiesSourceV2(json(root, file), file).entities.map(e => ({
      id: e.entityId,
      name: e.name ?? e.entityId,
    })),
  )
  const names = new Map(
    m.locationFiles.flatMap(file =>
      parseWorldPackLocationsSource(json(root, file), file).locations.map(l => [l.locationId, l.name] as const),
    ),
  )
  const scenes = m.sceneFiles.flatMap(file =>
    parseWorldPackScenesSourceV2(json(root, file), file).scenes.map(s => ({
      id: s.sceneId,
      location: s.locationId,
      name: (s.locationId && names.get(s.locationId)) ?? s.locationId ?? s.sceneId,
    })),
  )
  const graphs = new Map<string, EditorGraph>(),
    scripts: string[] = []
  for (const file of m.assetFiles) {
    const match = /^scripts\/activities\/([a-z][a-z0-9-]{0,40})\.js$/.exec(file)
    if (!match && file !== 'scripts/activity.js') continue
    const key = match?.[1] ?? 'default'
    const original = generatedActivity(readFileSync(packPath(root, file), 'utf8'))
    if (original?.key === key && file === activityScriptPath(key)) {
      const path = layoutFolder + '/' + key + '.json'
      graphs.set(
        key,
        existsSync(packPath(root, path)) ? parseGraph({ ...original, layout: json(root, path) }) : original,
      )
    } else scripts.push(key)
  }
  const dir = packPath(root, draftFolder)
  if (existsSync(dir))
    for (const file of readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()) {
      const key = editorKey(file.slice(0, -5)),
        graph = parseGraph(json(root, draftFolder + '/' + file))
      if (key !== graph.key) throw new TypeError('活动键与文件名不一致：' + file)
      graphs.set(key, graph)
    }
  return {
    packId: m.packId,
    rules: ruleCatalog(root),
    characters,
    items,
    scenes,
    graphs: [...graphs.values()],
    scripts,
    plugins: Object.keys(m.plugins ?? {}),
    adjudications: scriptEntries(root),
  }
}
export type EditorProject = ReturnType<typeof readProject>
export function validateReferences(graph: EditorGraph, project: EditorProject) {
  if (project.scripts.includes(graph.key)) throw new TypeError('该活动已有手写脚本，请为新活动另取标识：' + graph.key)
  for (const choice of graph.choices) {
    for (const { use, label, field } of [
      ...conditionReferences(choice.condition),
      { use: choice.effect, field: 'effect', label: '结果赋值' },
    ]) {
      if (use?.kind === 'present' || use?.kind === 'held') {
        const records = use.kind === 'present' ? project.characters : project.items
        if (!records.some(r => r.id === use.ref))
          throw new TypeError([graph.key, choice.id, label, '引用不存在 ' + use.ref].join(' › '))
      }
      if (use?.kind !== 'local' && use?.kind !== 'world') continue
      const v = variableCandidates(
        project.rules.variables,
        graph.variables ?? [],
        graph.key,
        field === 'effect' ? 'effect' : 'condition',
      ).find(v => v.kind === use.kind && v.key === use.ref)
      if (!v || !acceptsVariableValue(v, use.value))
        throw new TypeError([graph.key, choice.id, label, '变量不可用或值不符合声明 ' + use.ref].join(' › '))
    }
    if (choice.ruling) {
      validateRuling(
        choice.ruling,
        rulingTargets(project.rules.variables, graph.variables ?? [], graph.key),
        project.adjudications.flatMap(s => (s.declaration ? [s.declaration] : [])),
      )
      if (choice.effect?.kind === choice.ruling.target.kind && choice.effect.ref === choice.ruling.target.ref)
        throw new TypeError('结果赋值与裁定不能同时写入同一变量：' + choice.effect.ref)
    }
  }
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function merged<T>(base: T, local: T, remote: T, field: string): T {
  if (equal(local, base)) return remote
  if (equal(remote, base) || equal(local, remote)) return local
  throw new EditConflict(field, base, remote, local)
}
function mergeGraph(base: EditorGraph | null, local: EditorGraph, remote: EditorGraph | null): EditorGraph {
  if (!base || !remote) {
    const result = merged(base, local, remote, local.key)
    if (!result) throw new EditConflict(local.key, base, remote, local)
    return result
  }
  const byId = (graph: EditorGraph, id: string) => graph.choices.find(choice => choice.id === id)
  const ids = new Set([...remote.choices, ...local.choices].map(c => c.id))
  const choices = [...ids].flatMap(id => {
    const b = byId(base, id),
      l = byId(local, id),
      r = byId(remote, id),
      path = local.key + '/' + id
    if (!b || !l || !r) {
      const c = merged(b, l, r, path)
      return c ? [c] : []
    }
    const ruling = merged(b.ruling, l.ruling, r.ruling, path + '/ruling')
    const effect = merged(b.effect, l.effect, r.effect, path + '/effect')
    return [
      {
        id,
        label: merged(b.label, l.label, r.label, path + '/label'),
        ...(effect ? { effect } : {}),
        ...(ruling ? { ruling } : {}),
        condition: merged(b.condition, l.condition, r.condition, path + '/condition'),
        result: merged(b.result, l.result, r.result, path + '/result'),
        speech: merged(b.speech, l.speech, r.speech, path + '/speech'),
        next: merged(b.next, l.next, r.next, path + '/next'),
      },
    ]
  })
  const surviving = new Map(choices.map(c => [c.id, c]))
  const common = new Set(
    base.choices.map(c => c.id).filter(id => surviving.has(id) && byId(local, id) && byId(remote, id)),
  )
  const commonOrder = (g: EditorGraph) => g.choices.map(c => c.id).filter(id => common.has(id))
  const order = [...merged(commonOrder(base), commonOrder(local), commonOrder(remote), local.key + '/order')]
  // Insert new choices at their authored positions relative to surviving neighbours.
  for (const graph of [remote, local]) {
    let insertAt = order.length
    for (const c of [...graph.choices].reverse()) {
      if (!surviving.has(c.id)) continue
      const current = order.indexOf(c.id)
      if (current < 0) order.splice(insertAt, 0, c.id)
      else insertAt = current
    }
  }
  return parseGraph({
    key: local.key,
    title: merged(base.title, local.title, remote.title, 'title'),
    variables: merged(base.variables, local.variables, remote.variables, 'variables'),
    opening: merged(base.opening, local.opening, remote.opening, 'opening'),
    layout: merged(base.layout, local.layout, remote.layout, 'layout')?.filter(
      node => node.title || node.id === 'start' || surviving.has(node.id),
    ),
    choices: order.map(id => surviving.get(id)!),
  })
}
export function saveGraph(source: string, rawBase: unknown, rawGraph: unknown) {
  return writeGraph(source, rawBase, rawGraph).saved
}
export function writeGraph(source: string, rawBase: unknown, rawGraph: unknown) {
  const root = realpathSync(source),
    graph = parseGraph(rawGraph),
    base = rawBase === null ? null : parseGraph(rawBase)
  if (base && base.key !== graph.key) throw new TypeError('不能通过保存更换活动键')
  const dir = packPath(root, draftFolder)
  mkdirSync(dir, { recursive: true })
  const lock = packPath(root, '.perspectra-editor-save.lock')
  let fd: number
  try {
    fd = openSync(lock, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new TypeError('另一编辑正在保存，请稍后重试。若进程已退出，可移除 .perspectra-editor-save.lock')
    throw error
  }
  const temp = join(dir, graph.key + '-' + randomUUID() + '.tmp')
  try {
    const project = readProject(root),
      current = project.graphs.find(g => g.key === graph.key) ?? null
    const saved = mergeGraph(base, graph, current)
    validateReferences(saved, project)
    if (current?.variables?.length && JSON.stringify(current.variables) !== JSON.stringify(saved.variables ?? []))
      checkKnowledgeActivities(root, [saved])
    writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx' })
    renameSync(temp, packPath(root, draftFolder + '/' + graph.key + '.json'))
    return { saved, previous: current }
  } catch (error) {
    if (error instanceof EditConflict && base) error.candidate = { base, graph }
    throw error
  } finally {
    closeSync(fd)
    rmSync(temp, { force: true })
    rmSync(lock, { force: true })
  }
}
