import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { diffLensViews } from './diff.ts'
import { parseScenario, runScenario } from './scenario.ts'
import { startLensServer } from './server.ts'
import { LensSimulation } from './simulation.ts'
import { LensStore } from './store.ts'
import { buildLensView } from './view.ts'

// Read-only entry for AI agents. Reads never call markSeen, and nothing here can add or close a change request.
// `serve` only hands the author their page; those actions stay behind the page's own token.
const USAGE =
  'usage: lens view <源目录> | lens requests <源目录> | lens simulate <源目录> <脚本.json> | lens serve <源目录> [--no-open]'
/** A server nobody has looked at for this long leaves, so one started in the background does not stay forever. */
const SERVE_IDLE_MS = 60 * 60 * 1000

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function currentView(packPath: string) {
  const opening = await LensSimulation.open(packPath)
  try {
    return await buildLensView(packPath, opening)
  } finally {
    await opening.close()
  }
}

function scenarioFile(packPath: string, name: string): string {
  const direct = resolve(name)
  if (existsSync(direct)) return direct
  const stored = isAbsolute(name) ? undefined : join(packPath, '.perspectra-lens', 'scenarios', name)
  if (stored && existsSync(stored)) return stored
  throw new CliError('SCENARIO_NOT_FOUND', `找不到推演脚本：${name}`)
}

async function run(args: readonly string[]): Promise<unknown> {
  const [command, source, script] = args
  const arity = { view: 2, requests: 2, simulate: 3 }[command ?? ''] ?? 0
  if (!arity || args.length !== arity) throw new CliError('INVALID_REQUEST', USAGE)
  const packPath = resolve(source!)
  if (!existsSync(join(packPath, 'worldpack.source.json')))
    throw new CliError('PACK_NOT_FOUND', `不是世界包源目录（缺少 worldpack.source.json）：${packPath}`)
  const store = new LensStore(packPath)
  if (command === 'view') {
    const view = await currentView(packPath)
    const seen = store.seen()
    return { view, changes: seen === null ? [] : diffLensViews(seen, view) }
  }
  if (command === 'requests') {
    const view = await currentView(packPath)
    return { requests: store.requests(view).filter(r => r.state === 'open' || r.state === 'changed') }
  }
  const file = scenarioFile(packPath, script!)
  let scenario
  try {
    scenario = parseScenario(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    throw new CliError('SCENARIO_INVALID', `推演脚本无效（${file}）：${(error as Error).message}`)
  }
  return runScenario(packPath, scenario)
}

const flush = (stream: NodeJS.WriteStream, text: string) => new Promise<void>(done => stream.write(text, () => done()))

/** Best effort: the address is already printed, so a browser that will not open is not a failure. */
function openBrowser(url: string): void {
  const [command, ...args] =
    process.platform === 'win32'
      ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', url]
  const child = spawn(command!, args, { stdio: 'ignore', detached: true, windowsHide: true })
  child.once('error', () => undefined)
  child.unref()
}

async function serve(args: readonly string[]): Promise<void> {
  const paths = args.filter(arg => arg !== '--no-open')
  if (paths.length !== 1) throw new CliError('INVALID_REQUEST', USAGE)
  const packPath = resolve(paths[0]!)
  if (!existsSync(join(packPath, 'worldpack.source.json')))
    throw new CliError('PACK_NOT_FOUND', `不是世界包源目录（缺少 worldpack.source.json）：${packPath}`)
  const server = await startLensServer(packPath)
  await flush(process.stdout, JSON.stringify({ command: 'serve', url: server.url }) + '\n')
  if (!args.includes('--no-open')) openBrowser(server.url)
  await new Promise<void>(done => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.once(signal, done)
    setInterval(() => {
      if (Date.now() - server.lastActivity() > SERVE_IDLE_MS) done()
    }, 60_000)
  })
  await server.close()
}

let exitCode = 0
try {
  const args = process.argv.slice(2)
  if (args[0] === 'serve') await serve(args.slice(1))
  else await flush(process.stdout, JSON.stringify(await run(args)) + '\n')
} catch (error) {
  exitCode = 1
  const code = error instanceof CliError ? error.code : 'LENS_FAILED'
  await flush(process.stderr, JSON.stringify({ error: { code, message: (error as Error).message } }) + '\n')
}
// The stub model server and runtime are closed by now; leave without waiting on stray handles.
process.exit(exitCode)
