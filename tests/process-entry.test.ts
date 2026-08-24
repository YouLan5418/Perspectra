import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
const root = process.cwd()
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

interface ProcessResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function run(entry: string, args: readonly string[] = [], input = ''): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', tsxCli, join(root, entry), ...args], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('process entrypoints', () => {
  it('loads every local entry and fails closed when required arguments are absent', async () => {
    const entries = [
      'packages/operations/process/application-cli-entry.ts',
      'packages/operations/process/cli-entry.ts',
      'packages/simulation/process/mystery-demo-entry.ts',
      'packages/simulation/process/mystery-drill-entry.ts',
      'packages/simulation/process/mystery-turn-entry.ts',
    ]
    const results = await Promise.all(entries.map(entry => run(entry)))
    for (const result of results) {
      expect(result.code).not.toBe(0)
      expect(result.stderr).not.toBe('')
    }
    const host = await run('packages/operations/process/headless-entry.ts', ['--unknown', 'value'])
    expect(host.code).not.toBe(0)
    expect(host.stderr).toContain('unknown worldhost option')
    const shell = await run('packages/simulation/process/mystery-shell-entry.ts', [], 'hello\n')
    expect(shell.code).not.toBe(0)
    expect(shell.stderr).not.toBe('')
  }, 15_000)

  it('serves worldctl and starts then cleanly closes the stdio host', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-process-entry-'))
    directories.push(directory)
    const worldPath = join(directory, 'world.sqlite')
    const sessionPath = join(directory, 'session.sqlite')
    const health = await run('packages/operations/process/cli-entry.ts', [worldPath, 'health'])
    expect(health).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(health.stdout)).toMatchObject({ jsonrpc: '2.0', result: { status: 'ready' } })
    const host = await run('packages/operations/process/headless-entry.ts', [worldPath, sessionPath])
    expect(host).toMatchObject({ code: 0, stdout: '', stderr: '' })
  })
})
