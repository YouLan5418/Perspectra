import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, join, dirname } from 'node:path'
import { mkdir, writeFile, readFile, access, readdir } from 'node:fs/promises'
import { build, transform } from 'esbuild'
// These templates embed function.toString(). Compare the same build transform, not tsx's output.
const expectedFrontend = await build({
  stdin: {
    contents:
      "import {defaultFrontendAssets} from './packages/frontend/src/default-template.ts';" +
      "import {officialStageRenderers} from './apps/host/src/official-bundle.ts';" +
      'const assets=defaultFrontendAssets(officialStageRenderers);' +
      'export const DEFAULT_PAGE=assets.page,DEFAULT_STYLE=assets.style,DEFAULT_SCRIPT=assets.script;' +
      "export {HOST_ACTIVITY_PAGE} from './apps/host/src/runtime/host-page.ts';",
    resolveDir: process.cwd(),
    sourcefile: 'portable-frontend-check.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: {
    js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(process.cwd()+'/package.json');",
  },
  write: false,
})
const { DEFAULT_PAGE, DEFAULT_STYLE, DEFAULT_SCRIPT, HOST_ACTIVITY_PAGE } = await import(
  'data:text/javascript;base64,' + Buffer.from(expectedFrontend.outputFiles[0].contents).toString('base64')
)
// Whole-host bundling can rename locals in embedded functions (key -> key3).
// Canonicalize only script syntax; preserve the HTML/CSS and observable string literals.
async function comparableAsset(path, content) {
  const script = async text => (await transform(text, { minify: true, format: 'esm', target: 'es2024' })).code
  if (path.endsWith('.js')) return script(content)
  if (path !== '/' && !path.endsWith('.html')) return content
  let normalized = '',
    cursor = 0
  for (const match of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)) {
    normalized += content.slice(cursor, match.index) + match[0].replace(match[1], await script(match[1]))
    cursor = match.index + match[0].length
  }
  return normalized + content.slice(cursor)
}
if (process.argv.length < 5 || process.argv.length > 6 || (process.argv[5] && process.argv[5] !== 'offline')) {
  throw Error('usage: verify-portable.mjs <program-root> <fresh-data-dir> <external-source-pack> [offline]')
}
const root = resolve(process.argv[2]),
  data = resolve(process.argv[3]),
  sourcePack = resolve(process.argv[4])
await mkdir(dirname(data), { recursive: true })
await mkdir(data)
const buildInfo = JSON.parse(await readFile(join(root, 'build-info.json'), 'utf8'))
if (buildInfo.includesDemoPacks !== false || (await readdir(root)).includes('examples')) {
  throw Error('Expected a program-only payload without demo packs')
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 portable verification required')
if (buildInfo.memoryRuntime !== 'Node worker' || !buildInfo.onnxruntimeNode)
  throw Error('Expected the Node memory runtime in build-info.json')
execFileSync(process.execPath, ['scripts/release/verify-worldpack-cli.mjs', root], {
  stdio: 'inherit',
  windowsHide: true,
})
await access(join(root, 'runtime/creator-assets/index.html'))
await access(join(root, 'runtime/editor-assets/index.html'))
const runtime = join(root, 'runtime')
async function checkNodeOnly(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      name = relative ? relative + '/' + entry.name : entry.name
    if (entry.isSymbolicLink()) throw Error('Portable runtime contains a link: ' + name)
    if (entry.isDirectory()) {
      if (/^(?:python|__pycache__)$/iu.test(entry.name))
        throw Error('Portable runtime contains a Python directory: ' + name)
      await checkNodeOnly(path, name)
    } else if (/\.(?:py|pyc)$/iu.test(entry.name)) {
      throw Error('Portable runtime contains Python source or bytecode: ' + name)
    }
  }
}
await checkNodeOnly(runtime)
for (const path of [
  'memory-core/node/core-worker.mjs',
  'memory-core/node/e5-worker.mjs',
  'node_modules/onnxruntime-node/package.json',
  'node_modules/onnxruntime-common/package.json',
  'node_modules/onnxruntime-common/dist/cjs/package.json',
  'node_modules/onnxruntime-common/dist/esm/package.json',
  'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node',
  'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
])
  await access(join(runtime, path))
const onnxInfo = JSON.parse(await readFile(join(runtime, 'node_modules/onnxruntime-node/package.json'), 'utf8')),
  commonInfo = JSON.parse(await readFile(join(runtime, 'node_modules/onnxruntime-common/package.json'), 'utf8')),
  commonCjs = JSON.parse(
    await readFile(join(runtime, 'node_modules/onnxruntime-common/dist/cjs/package.json'), 'utf8'),
  ),
  commonEsm = JSON.parse(
    await readFile(join(runtime, 'node_modules/onnxruntime-common/dist/esm/package.json'), 'utf8'),
  ),
  assets = JSON.parse(await readFile('packages/memory-core/e5-assets.json', 'utf8'))
if (onnxInfo.version !== buildInfo.onnxruntimeNode || commonInfo.version !== onnxInfo.version)
  throw Error('Portable ONNX Runtime package versions disagree with build-info.json')
if (commonCjs.type !== 'commonjs' || commonEsm.type !== 'module')
  throw Error('Portable onnxruntime-common module metadata is incomplete')
for (const [file, expected] of Object.entries(assets.files)) {
  const bytes = await readFile(join(runtime, 'models/e5-small', file))
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw Error('Portable E5 asset hash mismatch: ' + file)
}
for (const path of ['python', 'python.exe', 'memory-core/python']) {
  try {
    await access(join(runtime, path))
    throw Error('Portable payload still contains a Python runtime path: ' + path)
  } catch (error) {
    if (error.message?.startsWith('Portable payload')) throw error
    if (error.code !== 'ENOENT') throw error
  }
}
const nodeSmoke = join(data, 'node-e5-smoke.mjs')
await writeFile(
  nodeSmoke,
  `import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const runtime = process.argv[2]
const worker = new Worker(pathToFileURL(join(runtime, 'memory-core/node/e5-worker.mjs')), {
  workerData: { directory: join(runtime, 'models/e5-small') },
  execArgv: [],
})
try {
  const result = await new Promise((resolve, reject) => {
    worker.once('error', reject)
    worker.once('message', reply => reply.error ? reject(new Error(reply.error)) : resolve(reply.result))
    worker.postMessage({ texts: ['便携 Node CPU E5 编码验收'], query: false })
  })
  assert.equal(result.vectors.length, 1)
  assert.equal(result.vectors[0].length, 384)
  assert(result.vectors[0].every(Number.isFinite))
  process.stdout.write(JSON.stringify({ encoder: 'onnxruntime-node CPU', vectors: 1, dimensions: 384 }) + '\\n')
} finally {
  await worker.terminate()
}
`,
)
const cleanEnv = { ...process.env, PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0' }
for (const name of [
  'HCW_HINDSIGHT_PYTHON',
  'HCW_HINDSIGHT_CORE_DIR',
  'HF_HUB_OFFLINE',
  'TRANSFORMERS_OFFLINE',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONNOUSERSITE',
  'PYTHONDONTWRITEBYTECODE',
])
  delete cleanEnv[name]
const nodeMemoryResult = execFileSync(join(runtime, 'node.exe'), [nodeSmoke, runtime], {
  cwd: runtime,
  env: cleanEnv,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120_000,
})
await writeFile(join(data, 'node-memory-result.json'), nodeMemoryResult)
const env = {
  ...cleanEnv,
  PERSPECTRA_RUNTIME_ROOT: runtime,
  HCW_HINDSIGHT_ONNX_DIR: join(runtime, 'models/e5-small'),
  HCW_HINDSIGHT_CACHE_DIR: join(data, 'cache'),
}
const child = spawn(join(runtime, 'node.exe'), [join(runtime, 'launcher.mjs'), join(data, 'launcher')], {
  cwd: runtime,
  env,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let buffer = ''
const queue = []
const next = () =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('IPC deadline')), 60000)
    queue.push(v => {
      clearTimeout(timer)
      resolve(v)
    })
  })
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const i = buffer.indexOf('\n')
    if (i < 0) break
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    queue.shift()?.(JSON.parse(line))
  }
})
let stderr = ''
child.stderr.on('data', chunk => (stderr += chunk))
child.on('error', e => {
  throw e
})
child.on('exit', () => {
  while (queue.length) queue.shift()({ ok: false, error: 'Portable bridge exited before reply' })
})
const request = async value => {
  const pending = next()
  child.stdin.write(JSON.stringify(value) + '\n')
  const reply = await pending
  if (!reply.ok) throw Error(reply.error)
  return reply.result
}
try {
  const first = await request({ operation: 'snapshot' })
  if (first.packs.length !== 0) throw Error('not a fresh root')
  const connectionId = randomUUID(),
    model = 'gemini-3.7-flash'
  await request({
    operation: 'connection-save',
    connection: {
      id: connectionId,
      name: '本地 8046 网关',
      protocol: 'openai',
      endpoint: 'http://127.0.0.1:8046/v1/chat/completions',
    },
  })
  await request({ operation: 'load', path: sourcePack })
  const snapshot = await request({ operation: 'snapshot' })
  await request({
    operation: 'create',
    packageId: snapshot.packs[0].id,
    name: '便携验证',
    models: { decision: { connectionId, model } },
  })
  const connection =
    process.argv[5] === 'offline'
      ? { message: 'Skipped: offline verification' }
      : await request({ operation: 'test-model', connectionId, model })
  const started = await request({
    operation: 'start',
    instanceId: (await request({ operation: 'snapshot' })).instances[0].id,
  })
  if (started.core.state !== 'running') throw Error('Core not running')
  const opened = await request({ operation: 'open' }),
    origin = new URL(opened.url).origin
  const creatorPage = await fetch(origin + '/creator/', { signal: AbortSignal.timeout(15000) })
  if (
    creatorPage.status !== 200 ||
    (await creatorPage.text()) !== (await readFile(join(runtime, 'creator-assets/index.html'), 'utf8'))
  )
    throw Error('Portable creator page differs from the bundled build')
  for (const [path, expected] of [
    ['/', HOST_ACTIVITY_PAGE],
    ['/frontend/default.html', DEFAULT_PAGE],
    ['/frontend/default.css', DEFAULT_STYLE],
    ['/frontend/default.js', DEFAULT_SCRIPT],
  ]) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(15000) })
    const actual = await comparableAsset(path, await response.text())
    const comparableExpected = await comparableAsset(path, expected)
    if (!response.ok || actual !== comparableExpected) {
      let at = 0
      while (at < actual.length && actual[at] === comparableExpected[at]) at++
      throw Error(
        'Portable frontend differs from current source: ' +
          path +
          ' ' +
          JSON.stringify({
            status: response.status,
            at,
            actual: actual.slice(at, at + 160),
            expected: comparableExpected.slice(at, at + 160),
          }),
      )
    }
  }
  await request({ operation: 'stop' })
  await writeFile(
    join(data, 'smoke-result.json'),
    JSON.stringify(
      {
        fresh: true,
        packLoaded: true,
        instanceCreated: true,
        modelConnection: connection.message,
        coreStarted: true,
        coreStopped: true,
        frontendMatchesSource: true,
        programOnly: true,
        nodeMemory: JSON.parse(nodeMemoryResult),
        creatorCliPassed: true,
        sourcePack,
      },
      null,
      2,
    ),
  )
  console.log('Portable Node/Core smoke passed')
} finally {
  child.stdin.end()
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
}
