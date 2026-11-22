import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, expect, it } from 'vitest'

import { sweetWithoutPacing } from '../support/sweet-without-pacing.ts'
const SOURCE = sweetWithoutPacing()
const CLI = resolve('apps/host/src/cli/worldpack.ts')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})
let pack: string
beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'lens-cli-'))
  pack = join(root, 'pack')
  cpSync(SOURCE, pack, { recursive: true })
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

function command(cli: string, ...args: string[]) {
  return new Promise<{ code: number | null; out: any; err: any }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.once('error', reject)
    child.once('close', code => {
      // Node's own warnings share stderr; the JSON error is the line that starts with a brace.
      const errorLine = stderr.split('\n').find(line => line.startsWith('{')) ?? ''
      done({
        code,
        out: stdout.trim() ? JSON.parse(stdout) : undefined,
        // Exit 2 (a scenario that did not pass) reports on stdout and leaves no error line.
        err: errorLine ? JSON.parse(errorLine) : undefined,
      })
    })
  })
}
const worldpack = (...args: string[]) => command(CLI, ...args)

function scenarioFile(name: string, body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'lens-cli-scenario-'))
  roots.push(dir)
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(body))
  return path
}
const START = {
  status: { public: { slot: '深夜' } },
  scenes: { 'character:player': 'scene:living-room', 'character:deepseek': 'scene:kitchen' },
  skipAutoStart: ['prologue'],
}

it('simulate runs a scenario with expectations', async () => {
  const script = scenarioFile('midnight.json', {
    title: '深夜厨房',
    start: START,
    steps: [{ move: 'location:kitchen', expect: { started: 'midnight-fridge', status: { slot: '深夜' } } }],
  })
  const { code, out } = await worldpack('simulate', pack, script)
  expect(code).toBe(0)
  expect(out.passed).toBe(true)
  expect(out.title).toBe('深夜厨房')
  expect(out.steps[0].error).toBeUndefined()
  expect(out.steps[0].expectations).toEqual([
    { text: expect.stringContaining('midnight-fridge'), ok: true },
    { text: expect.stringContaining('slot'), ok: true },
  ])
}, 90_000)

it('simulate exits 2 when an expectation fails', async () => {
  const script = scenarioFile('wrong.json', {
    title: '时段写错',
    start: START,
    steps: [{ wait: true, expect: { status: { slot: '正午' } } }],
  })
  const { code, out } = await worldpack('simulate', pack, script)
  expect(code).toBe(2)
  expect(out.passed).toBe(false)
  expect(out.steps[0].expectations[0].ok).toBe(false)
}, 90_000)

it('simulate reports an unmatched action', async () => {
  const script = scenarioFile('nope.json', { title: 'x', start: START, steps: [{ interact: 'status:nope' }] })
  const { code, out } = await worldpack('simulate', pack, script)
  // The result is still on stdout; 2 says the scenario did not pass to a caller reading only the exit code.
  expect(code).toBe(2)
  expect(out.passed).toBe(false)
  expect(out.steps[0].error).toContain('status:nope')
  expect(out.steps[0].error).toContain('status:sleep-next-day')
}, 90_000)

it('simulate refuses an untargeted interact offered on several targets', async () => {
  const script = scenarioFile('ambiguous.json', {
    title: 'x',
    start: START,
    steps: [{ interact: 'contact:hold-hand' }],
  })
  const { code, out } = await worldpack('simulate', pack, script)
  expect(code).toBe(2)
  expect(out.steps[0].error).toContain('target')
  expect(out.steps[0].error).toContain('character:claude')
  expect(out.steps[0].error).toContain('character:gpt')
  expect(out.steps[0].step.action.parameters.definitionRef).toEqual({ id: 'contact:hold-hand' })
}, 90_000)

it('worldpack simulate exposes the formal in-process scenario and measured boundaries', async () => {
  const cli = resolve('apps/host/src/cli/worldpack.ts')
  const source = resolve('examples/world-packs/investigation')
  const result = await command(cli, 'simulate', source, join(source, 'scenario.json'))
  expect(result.code).toBe(0)
  expect(result.out.passed).toBe(true)
  expect(result.out.steps[2].resolutions).toContainEqual(
    expect.objectContaining({
      accepted: false,
      rejection: expect.objectContaining({ code: 'INSUFFICIENT_ENERGY' }),
    }),
  )
  for (const key of ['startupMs', 'setupMs', 'compileMs', 'initializeMs', 'executionMs', 'cleanupMs'])
    expect(result.out.timings[key]).toBeGreaterThan(0)
  const wrong = scenarioFile('b9-wrong.json', {
    title: '失败退出',
    steps: [
      { interact: 'investigation:search', expect: { resolution: { status: 'rejected', code: 'INSUFFICIENT_ENERGY' } } },
    ],
  })
  expect((await command(cli, 'simulate', source, wrong)).code).toBe(2)
  expect((await command(cli, 'simulate', source)).code).toBe(1)
}, 60_000)
