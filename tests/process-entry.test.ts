import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId } from '@harness-world/contracts'
import { openContextDatabase } from '@harness-world/agents'
import { LocalMemoryStore } from '@harness-world/memory'
import { SessionDeliveryAdapter, WorldStore } from '@harness-world/store-sqlite'

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
      'packages/operations/process/deployment-backup-entry.ts',
      'packages/world-pack/process/cli-entry.ts',
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
  }, 30_000)

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

  it('creates, validates, and restores an offline deployment through worlddeploy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-worlddeploy-entry-'))
    directories.push(directory)
    const dataDirectory = join(directory, 'host')
    const dataPath = join(dataDirectory, 'data')
    const world = new WorldStore(join(dataPath, 'world.sqlite'))
    const session = new SessionDeliveryAdapter(join(dataPath, 'session.sqlite'))
    const memory = new LocalMemoryStore(join(dataPath, 'memory.sqlite'), world)
    openContextDatabase(join(dataPath, 'context.sqlite')).close()
    memory.close()
    session.close()
    world.close()
    const artifact = join(directory, 'artifact')
    const created = await run('packages/operations/process/deployment-backup-entry.ts', [
      'create', artifact, '--data-dir', dataDirectory,
    ])
    expect(created).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(created.stdout)).toMatchObject({ format: 'world-deployment-backup/v1' })

    const validated = await run('packages/operations/process/deployment-backup-entry.ts', [
      'validate', artifact, '--data-dir', dataDirectory,
    ])
    expect(validated).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(validated.stdout)).toEqual(JSON.parse(created.stdout))

    const restored = join(directory, 'restored')
    const restore = await run('packages/operations/process/deployment-backup-entry.ts', [
      'restore', artifact, restored, '--data-dir', dataDirectory,
    ])
    expect(restore).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(restore.stdout)).toMatchObject({ format: 'world-deployment-restore-provenance/v1' })
  }, 60_000)

  it('finishes the in-flight quantum before a graceful stdio shutdown', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-process-shutdown-'))
    directories.push(directory)
    const dataDirectory = join(directory, 'host')
    const worldPath = join(dataDirectory, 'data', 'world.sqlite')
    mkdirSync(dirname(worldPath), { recursive: true })
    const address = {
      tenantId: brandId('tenant:host', 'TenantId'),
      worldId: brandId('world:host', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    const seed = new WorldApplication({
      worldPath, sessionPath: join(dataDirectory, 'data', 'session.sqlite'),
    })
    seed.activateSpec({
      schemaVersion: 1, address, timeMode: 'TURN_DRIVEN', roundQueueLimit: 4,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:host', name: 'Host' }],
      characters: [{ characterId: 'character:host', name: 'Host', locationId: 'location:host' }],
      playerBindings: [{
        principalId: 'principal:host', characterId: 'character:host', sessionId: 'session:host',
      }],
      plugins: [],
    })
    await seed.close()

    const submit = {
      jsonrpc: '2.0', id: 'shutdown:submit', method: 'round.submit',
      params: {
        address, idempotencyKey: 'shutdown:round', principalId: 'principal:host',
        action: { actionType: 'speak', parameters: { text: 'graceful shutdown' } },
        correlationId: 'shutdown:round',
      },
    }
    const host = await run(
      'packages/operations/process/headless-entry.ts',
      ['--data-dir', dataDirectory, '--shutdown-timeout-ms', '20000'],
      `${JSON.stringify(submit)}\n`,
    )
    expect(host).toMatchObject({ code: 0, stderr: '' })
    const written = host.stdout.split('\n').filter(line => line.length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
    expect(written.some(value => value.id === 'shutdown:submit')).toBe(true)

    const database = new DatabaseSync(worldPath, { readOnly: true })
    try {
      expect(database.prepare(`SELECT status FROM round_inbox WHERE idempotency_key = 'shutdown:round'`).get())
        .toMatchObject({ status: 'completed' })
      expect(database.prepare('SELECT COUNT(*) AS rounds FROM round_commits').get()).toMatchObject({ rounds: 2 })
      expect(database.prepare('SELECT COUNT(*) AS leases FROM writer_leases').get()).toMatchObject({ leases: 0 })
    } finally {
      database.close()
    }
  }, 60_000)
})
