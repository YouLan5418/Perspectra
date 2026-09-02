import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureWorldHostLayout,
  resolveWorldHostConfig,
  WorldHostInstanceLock,
  type InstanceLockRecord,
} from './host-config.ts'

const directories: string[] = []

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'hcw-host-config-'))
  directories.push(value)
  return value
}

function paths() {
  const root = directory()
  return { root, lockPath: join(root, 'instance.lock'), worldPath: join(root, 'world.sqlite') }
}

function lockRecord(overrides: Partial<InstanceLockRecord> = {}): InstanceLockRecord {
  return {
    pid: 42,
    instanceId: 'instance:old',
    startedAt: '2026-08-24T00:00:00.000Z',
    nonce: 'nonce:old',
    writerOwnerPrefix: 'worldhost:instance:old:nonce:old',
    ...overrides,
  }
}

function seedLock(path: string, record: unknown = lockRecord()): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(record), 'utf8')
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('worldhost configuration', () => {
  it('applies CLI over environment over YAML and creates the local layout', () => {
    const root = directory()
    const configPath = join(root, 'config', 'world-host.yml')
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(configPath, [
      'dataDirectory: yaml-root',
      'worldPath: yaml-world.sqlite',
      'sessionPath: yaml-session.sqlite',
      'memoryPath: yaml-memory.sqlite',
      'contextPath: yaml-context.sqlite',
      'leaseTtlMs: 9000',
      'maxConcurrentBranches: 8',
      'rescanIntervalMs: 2500',
      'shutdownTimeoutMs: 9000',
    ].join('\n'))
    const config = resolveWorldHostConfig([
      '--config', configPath,
      '--world-path', 'cli-world.sqlite',
      '--context-path', 'nested/cli-context.sqlite',
      '--lease-ttl-ms', '7000',
      '--max-concurrent-branches', '12',
      '--shutdown-timeout-ms', '11000',
    ], {
      cwd: root,
      platform: 'linux',
      homeDirectory: join(root, 'home'),
      env: {
        HCW_SESSION_PATH: 'env-session.sqlite',
        HCW_LEASE_TTL_MS: '8000',
        HCW_MAX_CONCURRENT_BRANCHES: '6',
        HCW_RESCAN_INTERVAL_MS: '1500',
        HCW_SHUTDOWN_TIMEOUT_MS: '10000',
      },
    })
    expect(config).toMatchObject({
      dataDirectory: join(root, 'yaml-root'),
      worldPath: join(root, 'cli-world.sqlite'),
      sessionPath: join(root, 'env-session.sqlite'),
      memoryPath: join(root, 'yaml-memory.sqlite'),
      contextPath: join(root, 'nested', 'cli-context.sqlite'),
      leaseTtlMs: 7000,
      maxConcurrentBranches: 12,
      rescanIntervalMs: 1500,
      shutdownTimeoutMs: 11000,
      configPath,
    })
    ensureWorldHostLayout(config)
    for (const path of [
      join(config.dataDirectory, 'backups'), join(config.dataDirectory, 'exports'), config.logDirectory,
      join(root, 'yaml-root'), join(root, 'nested'),
    ]) expect(existsSync(path)).toBe(true)
  })

  it('provides platform defaults, environment roots, and legacy positional paths', () => {
    const root = directory()
    expect(resolveWorldHostConfig([]).leaseTtlMs).toBe(5000)
    expect(resolveWorldHostConfig([])).toMatchObject({
      maxConcurrentBranches: 4, rescanIntervalMs: 1000, shutdownTimeoutMs: 35000,
    })
    const windows = resolveWorldHostConfig([], {
      cwd: root, platform: 'win32', homeDirectory: join(root, 'home'), env: { LOCALAPPDATA: join(root, 'local') },
    })
    expect(windows.dataDirectory).toBe(join(root, 'local', 'HarnessCordisWorld'))
    expect(windows.worldPath).toBe(join(windows.dataDirectory, 'data', 'world.sqlite'))
    expect(windows.contextPath).toBe(join(windows.dataDirectory, 'data', 'context.sqlite'))
    const fallbackWindows = resolveWorldHostConfig([], {
      cwd: root, platform: 'win32', homeDirectory: join(root, 'fallback-home'), env: {},
    })
    expect(fallbackWindows.dataDirectory).toContain(join('fallback-home', 'AppData', 'Local'))
    const linux = resolveWorldHostConfig([], {
      cwd: root, platform: 'linux', homeDirectory: join(root, 'home'), env: { XDG_DATA_HOME: join(root, 'xdg') },
    })
    expect(linux.dataDirectory).toBe(join(root, 'xdg', 'harness-cordis-world'))
    const fallbackLinux = resolveWorldHostConfig([], {
      cwd: root, platform: 'linux', homeDirectory: join(root, 'home'), env: {},
    })
    expect(fallbackLinux.dataDirectory).toContain(join('.local', 'share', 'harness-cordis-world'))
    const legacy = resolveWorldHostConfig(['legacy-world.sqlite', 'legacy-session.sqlite'], {
      cwd: root, platform: 'linux', homeDirectory: root, env: {},
    })
    expect(legacy).toMatchObject({
      worldPath: join(root, 'legacy-world.sqlite'), sessionPath: join(root, 'legacy-session.sqlite'), leaseTtlMs: 5000,
    })
    const environment = resolveWorldHostConfig([], {
      cwd: root,
      platform: 'linux',
      homeDirectory: root,
      env: {
        HCW_DATA_DIR: 'env-root',
        HCW_WORLD_PATH: 'env-world.sqlite',
        HCW_SESSION_PATH: 'env-session.sqlite',
        HCW_MEMORY_PATH: 'env-memory.sqlite',
        HCW_CONTEXT_PATH: 'env-context.sqlite',
      },
    })
    expect(environment).toMatchObject({
      dataDirectory: join(root, 'env-root'),
      worldPath: join(root, 'env-world.sqlite'),
      memoryPath: join(root, 'env-memory.sqlite'),
      contextPath: join(root, 'env-context.sqlite'),
    })
  })

  it('rejects malformed CLI, YAML, and lease durations', () => {
    const root = directory()
    const base = { cwd: root, platform: 'linux' as const, homeDirectory: root, env: {} }
    for (const args of [
      ['only-one-positional'], ['--world-path'], ['--world-path', '--session-path'], ['--unknown', 'value'],
    ]) expect(() => resolveWorldHostConfig(args, base)).toThrow()
    expect(() => resolveWorldHostConfig(['--lease-ttl-ms', '0'], base)).toThrow(RangeError)
    for (const args of [
      ['--max-concurrent-branches', '0'], ['--max-concurrent-branches', '33'],
      ['--max-concurrent-branches', '1.5'], ['--rescan-interval-ms', '99'],
      ['--rescan-interval-ms', '60001'], ['--rescan-interval-ms', 'nope'],
      ['--shutdown-timeout-ms', '999'], ['--shutdown-timeout-ms', '300001'],
    ]) expect(() => resolveWorldHostConfig(args, base)).toThrow(RangeError)
    expect(resolveWorldHostConfig(['--max-concurrent-branches', '1', '--rescan-interval-ms', '100'], base))
      .toMatchObject({ maxConcurrentBranches: 1, rescanIntervalMs: 100 })
    expect(resolveWorldHostConfig([
      '--max-concurrent-branches', '32', '--rescan-interval-ms', '60000', '--shutdown-timeout-ms', '300000',
    ], base)).toMatchObject({ maxConcurrentBranches: 32, rescanIntervalMs: 60_000, shutdownTimeoutMs: 300_000 })
    expect(resolveWorldHostConfig(['--shutdown-timeout-ms', '1000'], base))
      .toMatchObject({ shutdownTimeoutMs: 1_000 })
    const configPath = join(root, 'world-host.yml')
    for (const text of ['not yaml', 'unsupported: value', 'worldPath:', 'leaseTtlMs: nope']) {
      writeFileSync(configPath, text)
      expect(() => resolveWorldHostConfig(['--config', configPath], base)).toThrow()
    }
    writeFileSync(configPath, '# comment\nworldPath: "quoted.sqlite"\nsessionPath: \'single.sqlite\'\n')
    expect(resolveWorldHostConfig(['--config', configPath], base)).toMatchObject({
      worldPath: join(root, 'quoted.sqlite'), sessionPath: join(root, 'single.sqlite'),
    })
  })
})

describe('WorldHostInstanceLock', () => {
  it('atomically owns and releases one lock, including idempotent release', () => {
    const { lockPath, worldPath } = paths()
    const lock = WorldHostInstanceLock.acquire(lockPath, worldPath, {
      pid: 7, instanceId: 'instance:new', nonce: 'nonce:new', nowMs: 1_777_000_000_000,
    })
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(lock.record)
    expect(lock.record.writerOwnerPrefix).toBe('worldhost:instance:new:nonce:new')
    lock.release()
    lock.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('recovers only a dead lock with no active database writer', () => {
    const { lockPath, worldPath } = paths()
    seedLock(lockPath)
    const recovered = WorldHostInstanceLock.acquire(lockPath, worldPath, {
      pid: 8, instanceId: 'instance:new', nonce: 'nonce:new', nowMs: 100,
      processAlive: () => false, activeWriterLease: () => false,
    })
    expect(recovered.record.pid).toBe(8)
    recovered.release()

    seedLock(lockPath)
    expect(() => WorldHostInstanceLock.acquire(lockPath, worldPath, {
      processAlive: () => true, activeWriterLease: () => false,
    })).toThrow('already active')
    expect(() => WorldHostInstanceLock.acquire(lockPath, worldPath, {
      processAlive: () => false, activeWriterLease: () => true,
    })).toThrow('already active')
  })

  it('uses PID liveness and fails closed for permission errors', () => {
    const { lockPath, worldPath } = paths()
    seedLock(lockPath)
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }) })
    const recovered = WorldHostInstanceLock.acquire(lockPath, worldPath, { activeWriterLease: () => false })
    recovered.release()

    seedLock(lockPath)
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    expect(() => WorldHostInstanceLock.acquire(lockPath, worldPath, { activeWriterLease: () => false }))
      .toThrow('already active')
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(() => WorldHostInstanceLock.acquire(lockPath, worldPath, { activeWriterLease: () => false }))
      .toThrow('already active')
  })

  it('consults the durable writer lease before recovering a crashed process lock', () => {
    const { lockPath, worldPath } = paths()
    seedLock(lockPath)
    const absentDatabase = WorldHostInstanceLock.acquire(lockPath, worldPath, { processAlive: () => false, nowMs: 100 })
    absentDatabase.release()

    const db = new DatabaseSync(worldPath)
    db.exec('CREATE TABLE unrelated(value INTEGER) STRICT')
    db.close()
    seedLock(lockPath)
    const absentTable = WorldHostInstanceLock.acquire(lockPath, worldPath, { processAlive: () => false, nowMs: 100 })
    absentTable.release()

    const leaseDb = new DatabaseSync(worldPath)
    leaseDb.exec('CREATE TABLE writer_leases(owner_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL) STRICT')
    leaseDb.prepare('INSERT INTO writer_leases VALUES (?, ?)').run('old-owner', 99)
    leaseDb.close()
    seedLock(lockPath)
    const expired = WorldHostInstanceLock.acquire(lockPath, worldPath, { processAlive: () => false, nowMs: 100 })
    expired.release()

    const activeDb = new DatabaseSync(worldPath)
    activeDb.prepare('UPDATE writer_leases SET expires_at_ms = 101').run()
    activeDb.close()
    seedLock(lockPath)
    expect(() => WorldHostInstanceLock.acquire(lockPath, worldPath, { processAlive: () => false, nowMs: 100 }))
      .toThrow('already active')
  })

  it('rejects corrupt, changing, or foreign-owned lock records', () => {
    const nonExclusive = paths()
    expect(() => WorldHostInstanceLock.acquire(`${nonExclusive.lockPath}\0`, nonExclusive.worldPath)).toThrow()

    const malformedCases: unknown[] = [
      [],
      { ...lockRecord(), extra: true },
      { ...lockRecord(), pid: 0 },
      { ...lockRecord(), instanceId: '' },
      { ...lockRecord(), startedAt: 'invalid' },
      { ...lockRecord(), nonce: '' },
      { ...lockRecord(), writerOwnerPrefix: '' },
    ]
    for (const record of malformedCases) {
      const { lockPath, worldPath } = paths()
      seedLock(lockPath, record)
      expect(() => WorldHostInstanceLock.acquire(lockPath, worldPath)).toThrow()
    }

    const changed = paths()
    seedLock(changed.lockPath)
    expect(() => WorldHostInstanceLock.acquire(changed.lockPath, changed.worldPath, {
      processAlive: () => {
        seedLock(changed.lockPath, lockRecord({ nonce: 'nonce:changed' }))
        return false
      },
      activeWriterLease: () => false,
    })).toThrow('changed during stale-lock recovery')

    const foreign = paths()
    const lock = WorldHostInstanceLock.acquire(foreign.lockPath, foreign.worldPath, { nonce: 'nonce:ours' })
    seedLock(foreign.lockPath, lockRecord({ nonce: 'nonce:foreign' }))
    expect(() => lock.release()).toThrow('ownership changed')
  })
})
