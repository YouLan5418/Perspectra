import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { copyMemoryAssets, copyMemoryRuntime } from '../build/copy-memory-runtime.mjs'

const repository = resolve('.'),
  evidenceDirectory = await mkdtemp(resolve('.tmp/core-layout-')),
  runtime = join(evidenceDirectory, 'runtime'),
  backend = join(evidenceDirectory, 'dist/backend/playtest.mjs'),
  assets = resolve(process.env.HCW_HINDSIGHT_ONNX_DIR ?? '.tmp/hindsight-e5-small'),
  pack = resolve('examples/world-packs/prototype-g1')

const probeSource = `
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { createCoreWorker, coreE5WorkerEntry } from '@perspectra/memory-core'
const scope = { worldAddress: { tenantId: 'layout', worldId: 'layout', branchId: 'main' }, characterId: 'character:layout', asOfWorldSeq: 0 }
const core = createCoreWorker({ HCW_HINDSIGHT_ONNX_DIR: process.env.HCW_HINDSIGHT_ONNX_DIR })
let coreResult
try {
  coreResult = await core.run({ operation: 'reproject', archive: { scope, sources: [], facts: [], episodes: [], observations: [] } }, AbortSignal.timeout(30000))
} finally {
  await core.close()
}
assert.equal(coreResult.archive.scope.characterId, scope.characterId)
const entry = coreE5WorkerEntry()
const encoder = new Worker(entry, {
  workerData: { directory: process.env.HCW_HINDSIGHT_ONNX_DIR },
  env: {},
  execArgv: entry.pathname.endsWith('.ts') ? ['--experimental-transform-types'] : [],
})
let encoded
try {
  encoded = await new Promise((resolve, reject) => {
    encoder.once('error', reject)
    encoder.once('message', reply => reply.error ? reject(new Error(reply.error)) : resolve(reply.result))
    encoder.postMessage({ texts: ['隔离 Node E5 布局验收'], query: false })
  })
} finally {
  await encoder.terminate()
}
assert.equal(encoded.vectors.length, 1)
assert.equal(encoded.vectors[0].length, 384)
assert(encoded.vectors[0].every(Number.isFinite))
process.stdout.write(JSON.stringify({ coreWorker: 'passed', e5Worker: 'passed', vectorWidth: 384 }) + '\\n')
`

await mkdir(dirname(backend), { recursive: true })
await mkdir(runtime, { recursive: true })
await mkdir(join(dirname(backend), 'frontend-assets'), { recursive: true })
await mkdir(join(runtime, 'frontend-assets'), { recursive: true })
await cp(resolve('packages/frontend/assets/gpt-6.png'), join(dirname(backend), 'frontend-assets/gpt-6.png'), {
  recursive: true,
})
await build({
  entryPoints: ['apps/host/src/runtime/web-entry.ts'],
  outfile: backend,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  legalComments: 'eof',
  banner: {
    js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);",
  },
})
await cp(resolve('packages/frontend/assets/gpt-6.png'), join(runtime, 'frontend-assets/gpt-6.png'), {
  recursive: true,
})
await cp(backend, join(runtime, 'playtest.mjs'))
await copyMemoryRuntime(runtime)
await copyMemoryAssets(runtime)

const bundledProbe = join(evidenceDirectory, 'dist/backend/core-layout-probe.mjs')
await mkdir(dirname(bundledProbe), { recursive: true })
await build({
  stdin: { contents: probeSource, resolveDir: repository, sourcefile: 'core-layout-probe.ts' },
  outfile: bundledProbe,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['onnxruntime-node'],
  banner: {
    js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);",
  },
})
await cp(bundledProbe, join(runtime, 'core-layout-probe.mjs'))
const sourceProbe = join(evidenceDirectory, 'core-layout-probe.mjs')
await writeFile(sourceProbe, probeSource)

function environment(runtimeRoot, assetDirectory) {
  const env = { ...process.env }
  for (const name of [
    'PERSPECTRA_RUNTIME_ROOT',
    'HCW_HINDSIGHT_PYTHON',
    'HCW_HINDSIGHT_CORE_DIR',
    'HF_HUB_OFFLINE',
    'TRANSFORMERS_OFFLINE',
    'PYTHONHOME',
    'PYTHONPATH',
    'PYTHONNOUSERSITE',
    'PYTHONDONTWRITEBYTECODE',
    'HCW_LOCAL_MODEL',
    'HCW_LOCAL_ENDPOINT',
    'HCW_LOCAL_API_KEY',
    'HCW_MODEL_PROTOCOL',
    'PERSPECTRA_ROLE_MODELS',
    'PERSPECTRA_MODEL_KEYS',
    'PERSPECTRA_MODEL_ENDPOINT',
    'PERSPECTRA_MODEL',
    'PERSPECTRA_MODEL_API_KEY',
    'PERSPECTRA_MODEL_PROTOCOL',
    'PERSPECTRA_THINKING_LEVEL',
  ])
    delete env[name]
  env.HCW_HINDSIGHT_ONNX_DIR = assetDirectory
  env.PERSPECTRA_ROLE_MODELS = ''
  env.PERSPECTRA_MODEL_ENDPOINT = 'http://127.0.0.1:9/v1/chat/completions'
  env.PERSPECTRA_MODEL = 'offline-layout-check'
  env.PERSPECTRA_MODEL_API_KEY = ''
  if (runtimeRoot) env.PERSPECTRA_RUNTIME_ROOT = runtimeRoot
  return env
}

function runWorkerProbe(name, entry, args, cwd, env) {
  const result = spawnSync(process.execPath, [...args, entry], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${name} Node worker probe failed: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout.trim())
}

async function startHost(name, entry, args, cwd, runtimeRoot, assetDirectory) {
  const child = spawn(
    process.execPath,
    [...args, entry, '--pack', pack, '--data-dir', join(evidenceDirectory, name + '-world')],
    {
      cwd,
      env: environment(runtimeRoot, assetDirectory),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  )
  let errors = ''
  child.stderr.on('data', chunk => (errors += String(chunk)))
  try {
    const ready = await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${name} Host startup timed out: ${errors.slice(-1500)}`)),
        45_000,
      )
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`${name} Host exited before ready (${code}): ${errors.slice(-1500)}`))
      })
      child.on('message', message => {
        if (message?.type === 'ready') {
          clearTimeout(timer)
          done(message)
        } else if (message?.type === 'startup-error') {
          clearTimeout(timer)
          reject(new Error(`${name} Host startup failed: ${message.message}`))
        }
      })
    })
    const response = await fetch(`http://127.0.0.1:${ready.port}/api/state`, {
      headers: { 'x-playtest-token': ready.token },
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(response.status, 200, `${name} Host state response`)
    const state = await response.json()
    assert.equal(state.debug.memoryMode, 'core', `${name} default memory mode`)
    return { child, host: { status: response.status, memoryMode: state.debug.memoryMode } }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    throw error
  }
}

const layouts = [
  {
    name: 'typescript-source',
    entry: resolve('apps/host/src/runtime/web-entry.ts'),
    args: ['--import', 'tsx'],
    cwd: repository,
    runtimeRoot: undefined,
    assetDirectory: assets,
    probe: sourceProbe,
    probeArgs: ['--import', 'tsx'],
  },
  {
    name: 'bundled-backend-no-runtime-env',
    entry: backend,
    args: [],
    cwd: repository,
    runtimeRoot: undefined,
    assetDirectory: assets,
    probe: bundledProbe,
    probeArgs: [],
  },
  {
    name: 'isolated-node-runtime',
    entry: join(runtime, 'playtest.mjs'),
    args: [],
    cwd: runtime,
    runtimeRoot: runtime,
    assetDirectory: join(runtime, 'models/e5-small'),
    probe: join(runtime, 'core-layout-probe.mjs'),
    probeArgs: [],
  },
]

const results = []
for (const layout of layouts) {
  const env = environment(layout.runtimeRoot, layout.assetDirectory),
    worker = runWorkerProbe(layout.name, layout.probe, layout.probeArgs, layout.cwd, env),
    started = await startHost(
      layout.name,
      layout.entry,
      layout.args,
      layout.cwd,
      layout.runtimeRoot,
      layout.assetDirectory,
    )
  try {
    results.push({ layout: layout.name, ...worker, host: started.host })
  } finally {
    if (started.child.exitCode === null && started.child.signalCode === null) {
      const exited = once(started.child, 'exit')
      started.child.send({ type: 'shutdown' })
      await exited
    }
  }
}

const report = {
  defaultCoreHttp: results,
  modelRequests: 0,
  pythonRuntime: false,
  e5AssetsRevision: JSON.parse(await readFile('packages/memory-core/e5-assets.json', 'utf8')).revision,
  evidenceDirectory,
}
await writeFile(join(evidenceDirectory, 'result.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
