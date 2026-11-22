import type { PlayerView } from '@perspectra/frontend'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { acceptsVariableValue, conditionLeaves, rulingTargets, type Scalar } from '@perspectra/world-pack/editor-fields'
import { FrontendActions } from '../runtime/frontend-adapter.ts'
import { SCRIPT_SOURCE_LIMIT } from '@perspectra/sdk/contracts'
import { readRulingScript } from './adjudication-files.ts'
import { validateExportedPages } from '../runtime/activity-page-catalog.ts'
import { validateExportedEvents } from './event-options.ts'
import { materializePresets } from './presets.ts'
import { checkKnowledgeActivities, materializeKnowledge } from './knowledge.ts'
import { ruleEdits, materializeRules } from './rule-source.ts'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { activityScriptPath } from '../runtime/activity-source.ts'
import { LensSimulation } from '../simulation/simulation.ts'
import { assertStep, playerControls } from './trial-controls.ts'
export { assertStep } from './trial-controls.ts'
import { validateInstalledPack } from '../pack-validation.ts'
import { activityScript, generatedActivity, type EditorGraph } from './activity-graph.ts'
import { inside, layoutFolder, manifest, manifestFile, packPath, readProject, validateReferences } from './project.ts'

function copyEntry(source: string, target: string, name: string): void {
  const from = packPath(source, name),
    to = packPath(target, name),
    stat = lstatSync(from)
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const file of readdirSync(from)) copyEntry(source, target, name + '/' + file)
  } else if (stat.isFile()) {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  } else throw new TypeError('资源不是普通文件：' + name)
}
export async function buildSource(
  root: string,
  target: string,
  snapshot = readProject(root),
  prepare?: (stage: string) => void,
) {
  const m = manifest(root),
    files = new Set<string>()
  for (const [key, value] of Object.entries(m)) {
    if (key.endsWith('Files') && Array.isArray(value)) for (const file of value) files.add(String(file))
    else if (key.endsWith('File') && typeof value === 'string') files.add(value)
  }
  for (const name of [
    'frontend',
    'model-preset.json',
    'role-presets.json',
    'cover.png',
    'cover.jpg',
    'cover.jpeg',
    'cover.webp',
  ]) {
    if (existsSync(packPath(root, name))) files.add(name)
  }
  for (const module of snapshot.adjudications) files.add(module.path)
  for (const name of files) copyEntry(root, target, name)
  const assets = new Set(m.assetFiles)
  for (const module of snapshot.adjudications) assets.add(module.path)
  const originalManifest = readFileSync(packPath(root, manifestFile), 'utf8')
  const raw = JSON.parse(originalManifest)
  materializeRules(root, target, assets, raw, ruleEdits(root))
  materializeKnowledge(root, target, raw, assets)
  if (snapshot.graphs.length && assets.has('knowledge.json')) checkKnowledgeActivities(root, snapshot.graphs)
  materializePresets(root, target, assets)
  for (const graph of snapshot.graphs) {
    validateReferences(graph, snapshot)
    const name = activityScriptPath(graph.key),
      original = packPath(root, name)
    const keys = new Set(graph.choices.flatMap(c => (c.ruling?.kind === 'script' ? [c.ruling.script] : [])))
    const sources = Object.fromEntries(
      [...keys].sort().map(k => [k, readRulingScript(target, k).source.replaceAll('\r\n', '\n')]),
    )
    const output = activityScript(graph, sources)
    if (Buffer.byteLength(output) > SCRIPT_SOURCE_LIMIT)
      throw new TypeError('生成的活动脚本超出运行时上限：' + graph.key)
    if (existsSync(original)) {
      const existing = generatedActivity(readFileSync(original, 'utf8'))
      if (existing?.key !== graph.key) throw new TypeError('保留手写脚本，请更换活动键：' + name)
      if (assets.has(name) && readFileSync(original, 'utf8').replaceAll('\r\n', '\n') === output) continue
    }
    const script = packPath(target, name)
    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, output)
    assets.add(name)
  }
  if (snapshot.graphs.length) {
    if (
      !raw.plugins?.['pack-scripts'] &&
      (snapshot.scripts.length || assets.has('scripts/status.js') || assets.has('plugins.json'))
    )
      throw new TypeError('启用活动也会启用这个包里已有的脚本。请先核对脚本并在源清单显式启用 pack-scripts。')
    raw.plugins = { ...raw.plugins, 'pack-scripts': raw.plugins?.['pack-scripts'] ?? {} }
  }
  if (assets.size !== m.assetFiles.length || m.assetFiles.some(f => !assets.has(f))) raw.assetFiles = [...assets]
  writeFileSync(
    join(target, manifestFile),
    JSON.stringify(raw) === JSON.stringify(JSON.parse(originalManifest))
      ? originalManifest
      : JSON.stringify(raw, null, 2) + '\n',
  )
  prepare?.(target)
  await validateInstalledPack(target, [])
  await validateExportedEvents(target)
  await validateExportedPages(target)
}
export async function exportProject(source: string, destination?: string) {
  const root = realpathSync(source),
    target = resolve(destination ?? join(dirname(root), basename(root) + '-export-' + randomUUID()))
  const parent = realpathSync(dirname(target))
  if (inside(root, join(parent, basename(target))) || existsSync(target))
    throw new TypeError('请选择源包以外尚不存在的新目录')
  const stage = mkdtempSync(join(parent, '.perspectra-export-'))
  try {
    const snapshot = readProject(root)
    await buildSource(root, stage, snapshot)
    for (const graph of snapshot.graphs) {
      if (!graph.layout?.length) continue
      mkdirSync(packPath(stage, layoutFolder), { recursive: true })
      writeFileSync(
        packPath(stage, layoutFolder + '/' + graph.key + '.json'),
        JSON.stringify(graph.layout, null, 2) + '\n',
      )
    }
    if (existsSync(target)) throw new TypeError('导出目标已存在')
    renameSync(stage, target)
    return { directory: target }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export async function playActivity(
  source: string,
  key: string,
  scenes: Record<string, string> = {},
  operation?: string,
  expected?: EditorGraph,
  start: { take?: unknown; world?: unknown } = {},
) {
  const root = realpathSync(source),
    snapshot = readProject(root),
    graph = snapshot.graphs.find(g => g.key === key)
  if (!graph) throw new TypeError('找不到可编辑活动：' + key)
  if (expected && JSON.stringify(expected) !== JSON.stringify(graph))
    throw new TypeError('草稿刚有更新，请重新读取后试玩')
  const predicates = graph.choices.flatMap(c => conditionLeaves(c.condition))
  const take = start.take === undefined ? [] : start.take
  if (
    !Array.isArray(take) ||
    take.some(id => typeof id !== 'string' || !predicates.some(p => p.kind === 'held' && p.ref === id)) ||
    new Set(take).size !== take.length
  )
    throw new TypeError('试玩拿取物品须来自本活动的持有条件且不能重复')
  const overrides = start.world === undefined ? {} : start.world
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
    throw new TypeError('试玩世界变量须为键值表')
  const world: Record<string, Scalar> = {}
  for (const [key, value] of Object.entries(overrides)) {
    const def = snapshot.rules.variables.find(v => v.key === key && v.readable)
    if (!def || !predicates.some(p => p.kind === 'world' && p.ref === key) || !acceptsVariableValue(def, value))
      throw new TypeError('试玩世界变量不可用或值不符合声明：' + key)
    world[key] = value
  }
  const dir = mkdtempSync(join(tmpdir(), 'perspectra-editor-play-'))
  try {
    await buildSource(root, dir, snapshot)
    const sim = await LensSimulation.open(dir, {
      scenes,
      ...(Object.keys(world).length ? { status: { public: world } } : {}),
    })
    try {
      if (take.length) {
        const controls = playerControls(sim, sim.playerId)
        for (const id of take)
          await controls.itemAction(id, 'status:take', '起点无法拿起物品，请核对玩家地点和拾取规则：' + id)
      }
      const started = await sim.step({
        kind: 'activity',
        request: { activityKey: key, activityId: null, revision: 0, operation: 'start', parameters: {} },
      })
      assertStep(started)
      const state = await sim.state(),
        active = state.activities?.find(a => a.activityKey === key)
      if (typeof active?.id !== 'string' || !Array.isArray(active.options))
        throw new TypeError('活动未能开始，请检查开局和参与者')
      const offered = new Set(
        active.options.map(o => String((o as { definitionRef: { id: string } }).definitionRef.id)),
      )
      const checks = graph.choices.map(c => ({
        id: c.id,
        label: c.label,
        condition: c.condition,
        available: offered.has('activity:' + c.id),
      }))
      const ruling = graph.choices.find(c => c.id === operation)?.ruling
      const target =
        ruling &&
        rulingTargets(snapshot.rules.variables, graph.variables ?? [], key).find(
          v => v.kind === ruling.target.kind && v.key === ruling.target.ref,
        )
      const player = target ? new FrontendActions(sim.previewRuntime) : undefined
      function visibleValue(view: PlayerView) {
        if (!target) return null
        const activity = view.activities?.find(a => a.key === key)
        const variables =
          target.kind === 'local' ? activity?.[target.scope === 'private' ? 'private' : 'public'].variables : undefined
        const value =
          target.kind === 'world'
            ? view.statusBar?.find(s => s.key === target.key && s.holderId === null && s.current)?.value
            : (variables as WorldJsonObject | undefined)?.[target.key]
        return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' ? value : null
      }
      const before = player ? visibleValue(await player.view()) : null
      const trace =
        operation === undefined
          ? undefined
          : await sim.step({
              kind: 'activity',
              request: {
                activityKey: key,
                activityId: active.id,
                revision: Number(active.revision),
                operation,
                parameters: {},
              },
            })
      if (trace) assertStep(trace)
      const settlement =
        player && target ? { label: target.label, before, after: visibleValue(await player.view()) } : undefined
      return {
        graph,
        checks,
        ...(settlement ? { settlement } : {}),
        ...(trace ? { lines: trace.lines } : {}),
        scenes,
        packHash: sim.packHash,
      }
    } finally {
      await sim.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function playRules(root: string, rounds: unknown) {
  if (typeof rounds !== 'number' || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 16)
    throw new TypeError('试玩回合数应为 1–16')
  const dir = mkdtempSync(join(tmpdir(), 'perspectra-rule-play-'))
  try {
    await buildSource(realpathSync(root), dir)
    const sim = await LensSimulation.open(dir)
    try {
      const timeline = []
      for (let i = 1; i <= rounds; i++) {
        const step = await sim.step({ kind: 'wait' })
        assertStep(step)
        timeline.push({ round: i, lines: step.lines.filter(l => l.kind === 'status'), pacing: step.pacing })
      }
      return { timeline, occurrences: sim.worldOccurrences(), publicStatus: (await sim.statusTruth()).public }
    } finally {
      await sim.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
