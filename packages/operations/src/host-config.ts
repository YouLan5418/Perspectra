import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalizeWorldJson, compareWorldText, type WorldJsonObject } from '@harness-world/contracts'
import {
  MAX_CONCURRENT_BRANCHES_DEFAULT,
  MAX_CONCURRENT_BRANCHES_MAX,
  MAX_CONCURRENT_BRANCHES_MIN,
  RESCAN_INTERVAL_MS_DEFAULT,
  RESCAN_INTERVAL_MS_MAX,
  RESCAN_INTERVAL_MS_MIN,
} from './branch-work-scheduler.ts'

export interface WorldHostConfig {
  readonly dataDirectory: string
  readonly worldPath: string
  readonly sessionPath: string
  readonly memoryPath: string
  readonly contextPath: string
  readonly configPath: string
  readonly lockPath: string
  readonly backupDirectory: string
  readonly exportDirectory: string
  readonly logDirectory: string
  readonly leaseTtlMs: number
  readonly maxConcurrentBranches: number
  readonly rescanIntervalMs: number
}

export interface ResolveWorldHostConfigOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly platform?: NodeJS.Platform
  readonly homeDirectory?: string
}

const RAW_HOST_CONFIG_KEYS = Object.freeze([
  'dataDirectory', 'worldPath', 'sessionPath', 'memoryPath', 'contextPath', 'leaseTtlMs',
  'maxConcurrentBranches', 'rescanIntervalMs',
] as const)

type RawHostConfig = Partial<Record<typeof RAW_HOST_CONFIG_KEYS[number], string>>

const CLI_KEYS = new Map([
  ['--data-dir', 'dataDirectory'],
  ['--world-path', 'worldPath'],
  ['--session-path', 'sessionPath'],
  ['--memory-path', 'memoryPath'],
  ['--context-path', 'contextPath'],
  ['--lease-ttl-ms', 'leaseTtlMs'],
  ['--max-concurrent-branches', 'maxConcurrentBranches'],
  ['--rescan-interval-ms', 'rescanIntervalMs'],
] as const)

function requiredValue(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1]
  if (value === undefined || value.length === 0 || value.startsWith('--')) throw new TypeError(`${name} requires a value`)
  return value
}

function parseCli(args: readonly string[]): { readonly configPath?: string; readonly values: RawHostConfig } {
  if (args.length > 0 && !args[0]!.startsWith('--')) {
    if (args.length !== 2) throw new TypeError('legacy worldhost syntax requires <world.sqlite> <session.sqlite>')
    return { values: { dataDirectory: dirname(args[0]!), worldPath: args[0]!, sessionPath: args[1]! } }
  }
  const values: RawHostConfig = {}
  let configPath: string | undefined
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!
    const value = requiredValue(args, index, option)
    if (option === '--config') configPath = value
    else {
      const key = CLI_KEYS.get(option as never)
      if (key === undefined) throw new TypeError(`unknown worldhost option ${option}`)
      values[key] = value
    }
  }
  return configPath === undefined ? { values } : { configPath, values }
}

function parseFlatYaml(text: string): RawHostConfig {
  const result: RawHostConfig = {}
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/u.exec(trimmed)
    if (match === null) throw new TypeError(`world-host.yml line ${index + 1} is invalid`)
    const key = match[1] as keyof RawHostConfig
    if (!(RAW_HOST_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new TypeError(`world-host.yml key ${key} is unsupported`)
    }
    const rawValue = match[2]!
    const value = (rawValue.startsWith('"') && rawValue.endsWith('"'))
      || (rawValue.startsWith("'") && rawValue.endsWith("'"))
      ? rawValue.slice(1, -1)
      : rawValue
    if (value.length === 0) throw new TypeError(`world-host.yml key ${key} is empty`)
    result[key] = value
  }
  return result
}

function absolute(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value)
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RangeError(`${name} must be a positive safe integer`)
  return parsed
}

function boundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be a safe integer from ${minimum} through ${maximum}`)
  }
  return parsed
}

function defaultRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDirectory: string): string {
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(homeDirectory, 'AppData', 'Local'), 'HarnessCordisWorld')
  return join(env.XDG_DATA_HOME ?? join(homeDirectory, '.local', 'share'), 'harness-cordis-world')
}

/** Resolve the local-only host configuration with CLI > env > YAML > defaults precedence. */
export function resolveWorldHostConfig(
  args: readonly string[],
  options: ResolveWorldHostConfigOptions = {},
): WorldHostConfig {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const platform = options.platform ?? process.platform
  const homeDirectory = options.homeDirectory ?? homedir()
  const cli = parseCli(args)
  const initialRoot = defaultRoot(env, platform, homeDirectory)
  const configRoot = cli.values.dataDirectory ?? env.HCW_DATA_DIR ?? initialRoot
  const configPath = absolute(cwd, cli.configPath ?? env.HCW_CONFIG_PATH ?? join(configRoot, 'config', 'world-host.yml'))
  const yaml = existsSync(configPath) ? parseFlatYaml(readFileSync(configPath, 'utf8')) : {}
  const environment: RawHostConfig = {
    ...(env.HCW_DATA_DIR === undefined ? {} : { dataDirectory: env.HCW_DATA_DIR }),
    ...(env.HCW_WORLD_PATH === undefined ? {} : { worldPath: env.HCW_WORLD_PATH }),
    ...(env.HCW_SESSION_PATH === undefined ? {} : { sessionPath: env.HCW_SESSION_PATH }),
    ...(env.HCW_MEMORY_PATH === undefined ? {} : { memoryPath: env.HCW_MEMORY_PATH }),
    ...(env.HCW_CONTEXT_PATH === undefined ? {} : { contextPath: env.HCW_CONTEXT_PATH }),
    ...(env.HCW_LEASE_TTL_MS === undefined ? {} : { leaseTtlMs: env.HCW_LEASE_TTL_MS }),
    ...(env.HCW_MAX_CONCURRENT_BRANCHES === undefined ? {} : { maxConcurrentBranches: env.HCW_MAX_CONCURRENT_BRANCHES }),
    ...(env.HCW_RESCAN_INTERVAL_MS === undefined ? {} : { rescanIntervalMs: env.HCW_RESCAN_INTERVAL_MS }),
  }
  const merged = { ...yaml, ...environment, ...cli.values }
  const dataDirectory = absolute(cwd, merged.dataDirectory ?? initialRoot)
  const dataPath = join(dataDirectory, 'data')
  return {
    dataDirectory,
    worldPath: absolute(cwd, merged.worldPath ?? join(dataPath, 'world.sqlite')),
    sessionPath: absolute(cwd, merged.sessionPath ?? join(dataPath, 'session.sqlite')),
    memoryPath: absolute(cwd, merged.memoryPath ?? join(dataPath, 'memory.sqlite')),
    contextPath: absolute(cwd, merged.contextPath ?? join(dataPath, 'context.sqlite')),
    configPath,
    lockPath: join(dataDirectory, 'instance.lock'),
    backupDirectory: join(dataDirectory, 'backups'),
    exportDirectory: join(dataDirectory, 'exports'),
    logDirectory: join(dataDirectory, 'logs'),
    leaseTtlMs: positiveInteger(merged.leaseTtlMs ?? '5000', 'leaseTtlMs'),
    maxConcurrentBranches: boundedInteger(
      merged.maxConcurrentBranches ?? String(MAX_CONCURRENT_BRANCHES_DEFAULT),
      'maxConcurrentBranches', MAX_CONCURRENT_BRANCHES_MIN, MAX_CONCURRENT_BRANCHES_MAX,
    ),
    rescanIntervalMs: boundedInteger(
      merged.rescanIntervalMs ?? String(RESCAN_INTERVAL_MS_DEFAULT),
      'rescanIntervalMs', RESCAN_INTERVAL_MS_MIN, RESCAN_INTERVAL_MS_MAX,
    ),
  }
}

export function ensureWorldHostLayout(config: WorldHostConfig): void {
  for (const path of [
    dirname(config.worldPath), dirname(config.sessionPath), dirname(config.memoryPath), dirname(config.contextPath),
    dirname(config.configPath), config.backupDirectory, config.exportDirectory, config.logDirectory,
  ]) mkdirSync(path, { recursive: true })
}

export interface InstanceLockRecord extends WorldJsonObject {
  readonly pid: number
  readonly instanceId: string
  readonly startedAt: string
  readonly nonce: string
  readonly writerOwnerPrefix: string
}

export interface InstanceLockOptions {
  readonly pid?: number
  readonly instanceId?: string
  readonly nonce?: string
  readonly nowMs?: number
  readonly processAlive?: (pid: number) => boolean
  readonly activeWriterLease?: (worldPath: string, nowMs: number) => boolean
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')
  }
}

function defaultActiveWriterLease(worldPath: string, nowMs: number): boolean {
  if (!existsSync(worldPath)) return false
  const db = new DatabaseSync(worldPath, { readOnly: true })
  try {
    const table = db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'writer_leases'`).get()
    if (table === undefined) return false
    return db.prepare(`SELECT 1 AS present FROM writer_leases WHERE expires_at_ms > ? LIMIT 1`).get(nowMs) !== undefined
  } finally {
    db.close()
  }
}

function parseLock(text: string): InstanceLockRecord {
  const value: unknown = JSON.parse(text)
  canonicalizeWorldJson(value as WorldJsonObject)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('instance.lock must be an object')
  const record = value as Partial<InstanceLockRecord>
  const keys = Object.keys(record).sort(compareWorldText)
  if (keys.join(',') !== 'instanceId,nonce,pid,startedAt,writerOwnerPrefix'
    || !Number.isSafeInteger(record.pid) || record.pid! <= 0
    || typeof record.instanceId !== 'string' || record.instanceId.length === 0
    || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))
    || typeof record.nonce !== 'string' || record.nonce.length === 0
    || typeof record.writerOwnerPrefix !== 'string' || record.writerOwnerPrefix.length === 0) {
    throw new TypeError('instance.lock has an invalid record')
  }
  return record as InstanceLockRecord
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function writeExclusive(path: string, record: InstanceLockRecord): void {
  const descriptor = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(descriptor, canonicalizeWorldJson(record))
  } finally {
    closeSync(descriptor)
  }
}

/** Process-level ownership guard. Database writer fencing remains the authoritative mutation guard. */
export class WorldHostInstanceLock {
  readonly record: InstanceLockRecord
  #released = false

  private constructor(readonly path: string, record: InstanceLockRecord) {
    this.record = record
  }

  static acquire(lockPath: string, worldPath: string, options: InstanceLockOptions = {}): WorldHostInstanceLock {
    mkdirSync(dirname(lockPath), { recursive: true })
    const nowMs = options.nowMs ?? Date.now()
    const instanceId = options.instanceId ?? randomUUID()
    const nonce = options.nonce ?? randomUUID()
    const record: InstanceLockRecord = {
      pid: options.pid ?? process.pid,
      instanceId,
      startedAt: new Date(nowMs).toISOString(),
      nonce,
      writerOwnerPrefix: `worldhost:${instanceId}:${nonce}`,
    }
    try {
      writeExclusive(lockPath, record)
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error
      const original = readFileSync(lockPath, 'utf8')
      const existing = parseLock(original)
      const processAlive = (options.processAlive ?? defaultProcessAlive)(existing.pid)
      const activeLease = (options.activeWriterLease ?? defaultActiveWriterLease)(worldPath, nowMs)
      if (processAlive || activeLease) throw new Error('worldhost instance is already active')
      if (readFileSync(lockPath, 'utf8') !== original) throw new Error('instance.lock changed during stale-lock recovery')
      unlinkSync(lockPath)
      writeExclusive(lockPath, record)
    }
    return new WorldHostInstanceLock(lockPath, record)
  }

  release(): void {
    if (this.#released) return
    const current = parseLock(readFileSync(this.path, 'utf8'))
    if (current.nonce !== this.record.nonce) throw new Error('instance.lock ownership changed before release')
    unlinkSync(this.path)
    this.#released = true
  }
}
