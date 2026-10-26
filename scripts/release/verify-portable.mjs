import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve, join, dirname } from 'node:path'
import { mkdir, writeFile, readFile, access, readdir } from 'node:fs/promises'
import { build, transform } from 'esbuild'
// These templates embed function.toString(). Compare the same build transform, not tsx's output.
const expectedFrontend = await build({
  stdin: {
    contents:
      "export {DEFAULT_PAGE,DEFAULT_STYLE,DEFAULT_SCRIPT} from './packages/frontend/src/default-template.ts';" +
      "export {HOST_ACTIVITY_PAGE} from './desktop/host/host-page.ts';",
    resolveDir: process.cwd(),
    sourcefile: 'portable-frontend-check.ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
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
execFileSync(process.execPath, ['scripts/release/verify-worldpack-cli.mjs', root], {
  stdio: 'inherit',
  windowsHide: true,
})
await access(join(root, 'runtime/creator-assets/index.html'))
const runtime = join(root, 'runtime')
const env = {
  ...process.env,
  PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  PERSPECTRA_RUNTIME_ROOT: runtime,
  HCW_HINDSIGHT_PYTHON: join(runtime, 'python/python.exe'),
  HCW_HINDSIGHT_CORE_DIR: join(runtime, 'memory-core/python/core'),
  HCW_HINDSIGHT_ONNX_DIR: join(runtime, 'models/e5-small'),
  HCW_HINDSIGHT_CACHE_DIR: join(data, 'cache'),
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONHOME: undefined,
  PYTHONPATH: undefined,
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
const python = spawn(
  join(runtime, 'python/python.exe'),
  ['-I', '-B', resolve('scripts/release/verify-python.py'), runtime],
  { cwd: runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
)
let output = '',
  error = ''
python.stdout.on('data', s => (output += s))
python.stderr.on('data', s => (error += s))
const code = await new Promise(resolve => python.once('exit', resolve))
if (code !== 0) throw Error('Python smoke failed: ' + error.slice(-1500))
await writeFile(join(data, 'python-result.json'), output)
console.log(output.trim())
