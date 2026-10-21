import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const directories: string[] = []
const root = process.cwd()
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

interface ProcessResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function run(args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', tsxCli,
      join(root, 'packages/world-pack/process/cli-entry.ts'), ...args], {
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
    child.stdin.end()
  })
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('compiles a v5 Pack through the worldpack process entry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-worldpack-entry-'))
  directories.push(directory)
  const output = join(directory, 'hand.wp.json')
  const result = await run(['compile', 'examples/world-packs/hand-in-hand', '--out', output])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(result.stdout)).toMatchObject({ command: 'compile', status: 'compiled', packId: 'pack:hand-in-hand' })
  expect(existsSync(output)).toBe(true)
}, 60_000)
