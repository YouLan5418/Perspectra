import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { diffLensViews } from './diff.ts'
import { parseScenario, runScenario } from './scenario.ts'
import { LensSimulation } from './simulation.ts'
import { LensStore } from './store.ts'
import { buildLensView } from './view.ts'

// Read-only entry for AI agents. Reads never call markSeen, and nothing here can add or close a change request.
const USAGE = 'usage: lens view <源目录> | lens requests <源目录> | lens simulate <源目录> <脚本.json>'

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
let exitCode = 0
try {
  await flush(process.stdout, JSON.stringify(await run(process.argv.slice(2))) + '\n')
} catch (error) {
  exitCode = 1
  const code = error instanceof CliError ? error.code : 'LENS_FAILED'
  await flush(process.stderr, JSON.stringify({ error: { code, message: (error as Error).message } }) + '\n')
}
// The stub model server and runtime are closed by now; leave without waiting on stray handles.
process.exit(exitCode)
