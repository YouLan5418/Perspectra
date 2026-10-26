import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildWorldPackCli } from '../build/build-worldpack-cli.mjs'

// With no argument, build a small isolated layout; with a root, test the actual portable payload.
// All fixtures and databases are fresh and outside the repository. No external model calls.
const work = await mkdtemp(join(tmpdir(), 'Perspectra CLI 中文 '))
const root = process.argv[2] ? resolve(process.argv[2]) : join(work, '程序 空格')
if (!process.argv[2]) {
  await buildWorldPackCli(root)
  await cp(process.execPath, join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))
}
const cwd = join(work, '工作目录')
await mkdir(cwd)
const source = join(work, '我的游戏')
await cp(resolve('examples/world-packs/hand-in-hand'), source, { recursive: true })
// A compiler check must read this asset without running it.
await writeFile(join(source, 'scripts/status.js'), 'throw new Error("CLI must not execute gameplay scripts")\n')
const env = { ...process.env, PATH: '', NODE_OPTIONS: '', NODE_PATH: '' }
const run = async args => {
  const windows = process.platform === 'win32'
  const child = windows
    ? spawn(
        process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', `""${join(root, 'worldpack.cmd')}" ${args.map(arg => `"${arg}"`).join(' ')}"`],
        { cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    : spawn(
        join(root, 'runtime/node'),
        ['--disable-warning=ExperimentalWarning', join(root, 'runtime/worldpack.mjs'), ...args],
        {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
  let stdout = '',
    stderr = ''
  child.stdout.on('data', chunk => (stdout += chunk))
  child.stderr.on('data', chunk => (stderr += chunk))
  const timer = setTimeout(() => child.kill(), 30_000)
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', done)
    })
    const line = code === 0 ? stdout : stderr
    assert.notEqual(line.trim(), '', `CLI exited with code ${code} without JSON output`)
    assert.equal(line.trim().split('\n').length, 1, `Expected one JSON line: ${line}`)
    const result = JSON.parse(line)
    if (code !== 0) assert.equal(stdout, '', 'Failures must not look like successful JSON output')
    return { code, result }
  } finally {
    clearTimeout(timer)
  }
}
const success = async args => {
  const { code, result } = await run(args)
  assert.equal(code, 0, JSON.stringify(result))
  return result
}
const version = await success(['--version'])
const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(version.version, packageJson.version)
assert.equal(version.sourceSchemaVersion, 'worldpack-source/v5')
assert.equal((await success(['--help'])).command, 'help')
assert.equal((await success(['validate', source])).status, 'valid')
const report = (await success(['test', source])).report
assert.equal(report.status, 'compiled')
assert.equal(report.assertionsExecuted, 0)
const artifact = join(work, '编译结果', 'game.worldpack.json')
assert.equal((await success(['compile', source, '--out', artifact])).status, 'compiled')
assert.equal((await success(['inspect', artifact])).inspection.packId, 'pack:hand-in-hand')
assert.equal((await success(['activate', artifact, '--data-dir', join(work, '新实验数据')])).status, 'activated')
const usage = await run(['unknown'])
assert.equal(usage.code, 1)
assert.equal(usage.result.errorCode, 'INVALID_REQUEST')
const manifestPath = join(source, 'worldpack.source.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
await writeFile(manifestPath, JSON.stringify({ ...manifest, sourceSchemaVersion: 'worldpack-source/v99' }))
const invalid = await run(['validate', source])
assert.equal(invalid.code, 1)
assert.equal(invalid.result.details.diagnostics[0].file, 'worldpack.source.json')
assert.equal(invalid.result.details.diagnostics[0].jsonPointer, '/sourceSchemaVersion')
await writeFile(manifestPath, JSON.stringify(manifest))
const charactersPath = join(source, 'characters.json')
const characters = JSON.parse(await readFile(charactersPath, 'utf8'))
characters.characters[0].initialLocationId = 'location:missing'
await writeFile(charactersPath, JSON.stringify(characters))
const reference = await run(['validate', source])
assert.equal(reference.code, 1)
assert.equal(reference.result.errorCode, 'PACK_REFERENCE_INVALID')
const missing = await run(['validate', join(work, '不存在')])
assert.equal(missing.code, 1)
assert.equal(typeof missing.result.message, 'string')
console.log(
  JSON.stringify({
    status: 'passed',
    root,
    evidenceDirectory: work,
    version: version.version,
    isolatedPath: true,
    modelCalls: 0,
    assertionsExecuted: 0,
    checks: [
      'version',
      'help',
      'validate',
      'test',
      'compile',
      'inspect',
      'activate',
      'usage',
      'schema',
      'references',
      'missing-source',
      'scripts-not-executed',
    ],
  }),
)
