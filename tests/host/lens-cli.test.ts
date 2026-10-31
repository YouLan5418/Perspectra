import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { LensStore } from '../../desktop/lens/store.ts'
import type { LensItem, LensView } from '../../desktop/lens/view.ts'

const SOURCE = resolve('examples/world-packs/model-girls-sweet-days')
const CLI = resolve('desktop/lens/cli.ts')
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

function lens(...args: string[]) {
  return new Promise<{ code: number | null; out: any; err: any }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
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
        err: code === 0 ? undefined : JSON.parse(errorLine),
      })
    })
  })
}
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

it('view prints items and does not move the seen baseline', async () => {
  const store = new LensStore(pack)
  const stale: LensView = { packId: 'old', packVersion: '0', title: 'old', items: [] }
  store.markSeen(stale)
  const seenPath = join(pack, '.perspectra-lens', 'seen.json')
  const before = statSync(seenPath).mtimeMs
  const { code, out } = await lens('view', pack)
  expect(code).toBe(0)
  expect(out.view.items.length).toBeGreaterThan(10)
  expect(out.changes.length).toBe(out.view.items.length) // everything is new relative to the empty baseline
  expect(statSync(seenPath).mtimeMs).toBe(before)
  expect(store.seen()).toEqual(stale)
}, 90_000)

it('requests lists open and changed only', async () => {
  const { out } = await lens('view', pack)
  const items: LensItem[] = out.view.items
  const store = new LensStore(pack)
  const open = store.addRequest(items[0]!, '保持不变')
  const changed = store.addRequest({ ...items[1]!, fields: [{ key: 'x', label: 'X', value: 'old' }] }, '已被改动')
  const closed = store.addRequest(items[2]!, '已关闭')
  store.closeRequest(closed.id)
  const removed = store.addRequest({ ...items[3]!, id: 'character:gone' }, '已删除')
  const result = await lens('requests', pack)
  expect(result.code).toBe(0)
  const states = Object.fromEntries(result.out.requests.map((r: any) => [r.id, r.state]))
  expect(states).toEqual({ [open.id]: 'open', [changed.id]: 'changed' })
  expect(states[removed.id]).toBeUndefined()
}, 90_000)

it('simulate runs a scenario with expectations', async () => {
  const script = scenarioFile('midnight.json', {
    title: '深夜厨房',
    start: START,
    steps: [{ move: 'location:kitchen', expect: { started: 'midnight-fridge', status: { slot: '深夜' } } }],
  })
  const { code, out } = await lens('simulate', pack, script)
  expect(code).toBe(0)
  expect(out.title).toBe('深夜厨房')
  expect(out.steps[0].error).toBeUndefined()
  expect(out.steps[0].expectations).toEqual([
    { text: expect.stringContaining('midnight-fridge'), ok: true },
    { text: expect.stringContaining('slot'), ok: true },
  ])
}, 90_000)

it('simulate takes a script name from the pack scenarios folder', async () => {
  mkdirSync(join(pack, '.perspectra-lens', 'scenarios'), { recursive: true })
  writeFileSync(
    join(pack, '.perspectra-lens', 'scenarios', 'stored.json'),
    JSON.stringify({ title: '存档脚本', start: START, steps: [{ move: 'location:kitchen' }] }),
  )
  const { code, out } = await lens('simulate', pack, 'stored.json')
  expect(code).toBe(0)
  expect(out.title).toBe('存档脚本')
}, 90_000)

it('simulate reports an unmatched action', async () => {
  const script = scenarioFile('nope.json', { title: 'x', start: START, steps: [{ interact: 'status:nope' }] })
  const { code, out } = await lens('simulate', pack, script)
  expect(code).toBe(0)
  expect(out.steps[0].error).toContain('status:nope')
  expect(out.steps[0].error).toContain('status:sleep-next-day')
}, 90_000)

it('simulate refuses an untargeted interact offered on several targets', async () => {
  const script = scenarioFile('ambiguous.json', { title: 'x', start: START, steps: [{ interact: 'base:hold-hand' }] })
  const { code, out } = await lens('simulate', pack, script)
  expect(code).toBe(0)
  expect(out.steps[0].error).toContain('target')
  expect(out.steps[0].error).toContain('character:claude')
  expect(out.steps[0].error).toContain('character:gpt')
  expect(out.steps[0].step.action.parameters.definitionRef).toEqual({ id: 'base:hold-hand' })
}, 90_000)

it('bad scenario json names the path', async () => {
  const script = scenarioFile('bad.json', { title: 'x', steps: [{ expect: {} }] })
  const { code, err } = await lens('simulate', pack, script)
  expect(code).toBe(1)
  expect(err.error.code).toBe('SCENARIO_INVALID')
  expect(err.error.message).toContain('steps[0]')
}, 90_000)

it('rejects unknown commands with a usage error', async () => {
  const { code, err } = await lens('close', pack)
  expect(code).toBe(1)
  expect(err.error.code).toBe('INVALID_REQUEST')
})
