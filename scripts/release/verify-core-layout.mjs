import { build } from 'esbuild'
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { copyMemoryRuntime } from '../build/copy-memory-runtime.mjs'
// No external model calls. Reuses the configured local Python/E5 environment.
await mkdir(resolve('.tmp'), { recursive: true })
const directory = await mkdtemp(resolve('.tmp/core-layout-')),
  runtime = join(directory, 'runtime')
await mkdir(runtime, { recursive: true })
await copyMemoryRuntime(runtime)
await cp(resolve('dist/backend/playtest.mjs'), join(runtime, 'playtest.mjs'))
await cp(resolve('packages/frontend/assets'), join(runtime, 'frontend-assets'), { recursive: true })
process.env.HCW_HINDSIGHT_PYTHON ??= resolve(
  '.tmp/hindsight-vector-venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
)
process.env.HCW_HINDSIGHT_ONNX_DIR ??= resolve('.tmp/hindsight-e5-small')
process.env.HCW_HINDSIGHT_CORE_DIR = resolve('desktop/host/memory/python/core')
process.env.HF_HUB_OFFLINE = '1'
process.env.TRANSFORMERS_OFFLINE = '1'
process.env.PYTHONDONTWRITEBYTECODE = '1'
process.env.PYTHONPATH = ''
const request = {
  operation: 'reproject',
  archive: {
    scope: {
      worldAddress: { tenantId: 'layout', worldId: 'layout', branchId: 'main' },
      characterId: 'character:test',
      asOfWorldSeq: 0,
    },
    sources: [],
    facts: [],
    episodes: [],
    observations: [],
  },
}
const source = await import(pathToFileURL(resolve('desktop/host/memory/python-worker.ts')).href)
delete process.env.PERSPECTRA_RUNTIME_ROOT
assert.equal(
  (await source.coreRunner()(request, AbortSignal.timeout(30000))).archive.scope.characterId,
  'character:test',
)
await build({
  entryPoints: ['desktop/host/memory/python-worker.ts'],
  outfile: join(runtime, 'worker-smoke.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
})
process.env.PERSPECTRA_RUNTIME_ROOT = runtime
process.env.HCW_HINDSIGHT_CORE_DIR = join(runtime, 'memory-core/python/core')
process.env.HCW_HINDSIGHT_CACHE_DIR = join(directory, 'cache')
const bundled = await import(pathToFileURL(join(runtime, 'worker-smoke.mjs')).href)
assert.equal(
  (await bundled.coreRunner()(request, AbortSignal.timeout(30000))).archive.scope.characterId,
  'character:test',
)
const worker = bundled.createCoreWorker()
try {
  for (let i = 0; i < 2; i++)
    assert.equal((await worker.run(request, AbortSignal.timeout(30000))).archive.scope.characterId, 'character:test')
} finally {
  await worker.close()
}
const encoded = execFileSync(
  process.env.HCW_HINDSIGHT_PYTHON,
  [
    '-B',
    '-c',
    "import sys,json;sys.path.insert(0,sys.argv[1]);import vector_core,numpy as np;v=vector_core.encode(['本地编码检查'],{'worldAddress':{'worldId':'layout','branchId':'main'},'characterId':'tester'});assert np.isfinite(v).all();print(json.dumps({'shape':list(v.shape)}))",
    join(runtime, 'memory-core/python/core'),
  ],
  { encoding: 'utf8', windowsHide: true },
)
console.log('Source and bundled Core runner, reusable worker and E5 encoder passed: ' + encoded.trim())
for (const layout of ['source', 'bundled', 'portable']) {
  const runtimeRoot = layout === 'source' ? undefined : layout === 'bundled' ? resolve('dist/backend') : runtime
  const env = {
    ...process.env,
    PERSPECTRA_RUNTIME_ROOT: runtimeRoot,
    HCW_HINDSIGHT_CORE_DIR:
      layout === 'source' ? resolve('desktop/host/memory/python/core') : join(runtimeRoot, 'memory-core/python/core'),
  }
  const entry = layout === 'portable' ? join(runtime, 'playtest.mjs') : resolve('dist/backend/playtest.mjs')
  const child = spawn(
    process.execPath,
    [entry, '--pack', resolve('examples/world-packs/prototype-g1'), '--data-dir', join(directory, layout + '-world')],
    { cwd: layout === 'portable' ? runtime : resolve('.'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = '',
    errors = ''
  child.stderr.on('data', chunk => (errors += chunk))
  try {
    const opened = await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(Error('startup timeout: ' + errors.slice(-1500))), 30000)
      child.stdout.on('data', chunk => {
        output += chunk
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*token=[a-f0-9]+/)
        if (match) {
          clearTimeout(timer)
          done(new URL(match[0]))
        }
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(Error('startup exited: ' + errors.slice(-1500)))
      })
    })
    const token = opened.hash.slice('#token='.length)
    const response = await fetch(opened.origin + '/api/state', {
      headers: { 'x-playtest-token': token },
      signal: AbortSignal.timeout(10000),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).debug.memoryMode, 'core')
    console.log('Built HTTP host started with default Core: ' + layout + ' layout.')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
}
await writeFile(
  join(directory, 'result.json'),
  JSON.stringify(
    {
      sourceRunner: true,
      bundledRunner: true,
      workerReuse: true,
      e5: JSON.parse(encoded),
      defaultCoreHttp: ['source', 'bundled', 'portable'],
      externalModelCalls: 0,
    },
    null,
    2,
  ),
)
console.log('Evidence: ' + join(directory, 'result.json'))
