import fs from 'node:fs'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import type { CoreRunner } from './hindsight-python.ts'
import { LauncherCore } from '../../desktop/launcher-core.ts'

// Test-only fault injection: no hooks or recovery machinery in production code.
const config = JSON.parse(process.argv[2]!) as {
  phase: string; root: string; pack: string; directory: string; instanceId: string; nodeId: string; lineId: string; sharePath: string
}
function halt(path: string): never {
  fs.writeSync(1, 'CRASH_POINT ' + JSON.stringify({ phase: config.phase, path }) + '\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw new Error('fault point unexpectedly resumed')
}
const originalWrite = fs.writeFileSync, originalRename = fs.renameSync, originalCopy = fs.copyFileSync
const originalAsyncRename = promises.rename
function install() {
  fs.writeFileSync = (...args: Parameters<typeof fs.writeFileSync>) => {
    const path = String(args[0])
    if ((config.phase === 'share-export-temporary' && path.endsWith('.perspectra-story.tmp'))
      || (config.phase === 'share-import-file' && path.includes('story-nodes') && basename(path) === 'world.sqlite')
      || (config.phase === 'save-unpublished' && basename(path) === 'memory-aliases.json')
      || (config.phase === 'memory-temporary' && path.includes('memory-core') && path.endsWith('.json.tmp'))) {
      // Leave an actual truncated JSON file, rather than a completely written temporary archive.
      originalWrite(args[0], String(args[1]).slice(0, Math.max(1, Math.floor(String(args[1]).length / 2))))
      halt(path)
    }
    originalWrite(...args)
  }
  fs.renameSync = (...args: Parameters<typeof fs.renameSync>) => {
    originalRename(...args)
    const path = String(args[1])
    if (config.phase === 'save-published' && String(args[0]).includes('story-nodes')) halt(path)
    if (config.phase === 'share-import-published' && String(args[0]).endsWith('.'+basename(path)) && path.includes('instances')) halt(path)
    if (config.phase === 'memory-one-role' && path.includes('memory-core') && path.endsWith('.json')) halt(path)
  }
  fs.copyFileSync = (...args: Parameters<typeof fs.copyFileSync>) => {
    originalCopy(...args)
    const path = String(args[1])
    if (config.phase === 'fork-copy' && path.includes('storylines') && basename(path) === 'world.sqlite') halt(path)
  }
  promises.rename = async (...args: Parameters<typeof promises.rename>) => {
    if (basename(String(args[1])) === 'launcher.json' && config.phase.endsWith('index-before')) halt(String(args[0]))
    await originalAsyncRename(...args)
    if (basename(String(args[1])) === 'launcher.json' && (config.phase === 'switch-index-after' || config.phase === 'share-import-index-after')) halt(String(args[1]))
  }
  syncBuiltinESMExports()
}
const run: CoreRunner = async input => {
  if (input.operation === 'build') throw new Error('Node restoration must never call memory Build')
  return { delivery: [], deliveryTrace: { delivered: [], activityCoverage: [] } }
}
const options = { packPath: config.pack, dataDirectory: config.directory, provider: 'local' as const,
  model: 'fixture', memoryCore: true, memoryCoreRun: run, memoryCoreBuildRun: run }
if (config.phase.startsWith('memory-')) {
  install()
  await FrozenWorldPlaytestRuntime.create(options)
} else if (config.phase.startsWith('save-')) {
  const runtime = await FrozenWorldPlaytestRuntime.create(options)
  install()
  await runtime.saveNode('强制终止中的节点')
} else {
  const core = new LauncherCore(process.cwd(), config.root)
  await core.initialize()
  install()
  await core.handle(config.phase.startsWith('share-import-')
    ? { operation: 'story-import', packageId: core.snapshot().packs[0]!.id, path: config.sharePath, name: '中断的导入' }
    : config.phase.startsWith('share-export-')
    ? { operation: 'story-export', instanceId: config.instanceId, nodeId: config.nodeId, path: config.sharePath }
    : config.phase.startsWith('fork-')
    ? { operation: 'story-fork', instanceId: config.instanceId, nodeId: config.nodeId, name: '中断的新线' }
    : { operation: 'story-select', instanceId: config.instanceId, storylineId: config.lineId })
}
throw new Error('operation completed without reaching requested fault point')
