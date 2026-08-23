import { existsSync } from 'node:fs'
import {
  brandId,
  canonicalizeWorldJson,
  type FaultInjector,
  type FaultPoint,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import { WorldHealthService } from '@harness-world/operations'
import { BranchAdministration } from '@harness-world/store-sqlite'
import { MYSTERY_DEMO_IDS, MysteryDemoScenario, type MysteryPlayerTurn } from './mystery-demo.ts'

export type MysteryDrillMode =
  | 'agent-failure'
  | 'agent-timeout'
  | 'budget-exhausted'
  | 'director-fallback'
  | 'memory-catchup-failure'
  | 'session-dead-letter'

const MODES = new Set<MysteryDrillMode>([
  'agent-failure', 'agent-timeout', 'budget-exhausted',
  'director-fallback', 'memory-catchup-failure', 'session-dead-letter',
])

class OneShotDrillFailure implements FaultInjector {
  #fired = false

  constructor(private readonly target: FaultPoint, private readonly message: string) {}

  hit(point: FaultPoint): void {
    if (point !== this.target || this.#fired) return
    this.#fired = true
    throw new Error(this.message)
  }
}

export interface MysteryDrillOptions {
  readonly mode: MysteryDrillMode
  readonly worldPath: string
  readonly sessionPath: string
}

export function requireSubmittedMysteryDrillTurn(
  turn: MysteryPlayerTurn,
): Extract<MysteryPlayerTurn, { readonly status: 'submitted' }> {
  if (turn.status !== 'submitted') throw new Error('Mystery drill Turn unexpectedly required clarification')
  return turn
}

export function mysteryDrillBranchHealth(worldPath: string): WorldJsonObject {
  const report = new WorldHealthService(worldPath).check()
  const branch = report.branches[0]
  if (branch === undefined) throw new Error('Mystery drill Health has no branch')
  return branch
}

export function parseMysteryDrillParticipantTerminals(authority: WorldJsonObject | undefined): WorldJsonObject[] {
  const participants = authority?.participants
  if (!Array.isArray(participants)) throw new Error('Mystery drill Round Authority has no participants')
  return participants.map((value): WorldJsonObject => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Mystery drill participant Authority is malformed')
    }
    const record = value as WorldJsonObject
    if (typeof record.participantId !== 'string' || typeof record.role !== 'string'
      || typeof record.terminalStatus !== 'string') {
      throw new Error('Mystery drill participant terminal is malformed')
    }
    return {
      participantId: record.participantId,
      role: record.role,
      terminalStatus: record.terminalStatus,
    }
  })
}

export function parseMysteryDrillRecoveryCharacters(value: WorldJsonValue | undefined): string[] {
  if (!Array.isArray(value)) throw new Error('Mystery drill Health availability is malformed')
  return value.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Mystery drill Health character availability is malformed')
    }
    const record = entry as WorldJsonObject
    if (typeof record.characterId !== 'string' || typeof record.state !== 'string') {
      throw new Error('Mystery drill Health character availability is malformed')
    }
    return record.state === 'ready' ? [] : [record.characterId]
  })
}

function auditEvidence(worldPath: string): WorldJsonObject[] {
  const administration = new BranchAdministration(worldPath)
  try {
    return administration.readAudit({
      tenantId: brandId(MYSTERY_DEMO_IDS.tenantId, 'TenantId'),
      worldId: brandId(MYSTERY_DEMO_IDS.worldId, 'WorldId'),
      branchId: brandId(MYSTERY_DEMO_IDS.branchId, 'BranchId'),
    }).filter(event => event.operation === 'round.committed' || event.operation === 'outbox.dead-lettered')
      .map(event => ({
        operation: event.operation,
        correlationId: event.correlationId,
        details: event.details,
      }))
  } finally {
    administration.close()
  }
}

function providerDelta(
  before: { readonly bob: number; readonly director: number },
  after: { readonly bob: number; readonly director: number },
): WorldJsonObject {
  return { bob: after.bob - before.bob, director: after.director - before.director }
}

/** Reproducible end-to-end degradation drill using only formal application paths and local durable stores. */
export async function runMysteryDrill(options: MysteryDrillOptions): Promise<WorldJsonObject> {
  if (!MODES.has(options.mode)) throw new TypeError('unknown Mystery drill mode')
  const profile = options.mode === 'agent-failure' || options.mode === 'agent-timeout'
    || options.mode === 'director-fallback' ? options.mode : undefined
  const initial = new MysteryDemoScenario({
    worldPath: options.worldPath,
    sessionPath: options.sessionPath,
    ...(profile === undefined ? {} : { providerProfile: profile }),
    ...(options.mode === 'budget-exhausted' ? { modelBudgetTokens: 0 } : {}),
    ...(options.mode === 'session-dead-letter' ? { outboxMaxAttempts: 1 } : {}),
    ...(options.mode === 'memory-catchup-failure' ? {
      faultInjector: new OneShotDrillFailure('memory.before-catchup', 'Demo drill Cognitive Memory catch-up failure'),
    } : {}),
    ...(options.mode === 'session-dead-letter' ? {
      faultInjector: new OneShotDrillFailure('session-delivery.after-inbox-insert', 'Demo drill Session delivery failure'),
    } : {}),
  })
  let initialEvidence: WorldJsonObject
  try {
    initial.activate()
    const playerTurn = requireSubmittedMysteryDrillTurn(
      await initial.submitPlayerText(`执行 ${options.mode} 降级演练。`, `mystery-drill:${options.mode}`),
    )
    let deliveryError: string | null = null
    try {
      await initial.deliver()
    } catch (error: unknown) {
      deliveryError = String(error)
    }
    const snapshot = await initial.snapshot()
    const beforeReplay = initial.providerCalls
    requireSubmittedMysteryDrillTurn(
      await initial.submitPlayerText(`执行 ${options.mode} 降级演练。`, `mystery-drill:${options.mode}`),
    )
    initialEvidence = {
      playerResult: playerTurn.result,
      participantTerminals: parseMysteryDrillParticipantTerminals(snapshot.authority?.authority),
      health: mysteryDrillBranchHealth(options.worldPath),
      audit: auditEvidence(options.worldPath),
      metrics: initial.runtimeMetrics,
      providerCalls: initial.providerCalls,
      replayProviderCalls: providerDelta(beforeReplay, initial.providerCalls),
      deliveryError,
    }
  } finally {
    await initial.close()
  }

  const recovered = new MysteryDemoScenario({ worldPath: options.worldPath, sessionPath: options.sessionPath })
  try {
    recovered.activate()
    const health = mysteryDrillBranchHealth(options.worldPath)
    for (const characterId of parseMysteryDrillRecoveryCharacters(health.characterAvailability)) {
      await recovered.setAvailability(characterId, 'ready', null)
    }
    for (const deadLetter of await recovered.deadLetters()) await recovered.retryDeadLetter(deadLetter.deliveryId)
    await recovered.deliver()
    const recoveryTurn = requireSubmittedMysteryDrillTurn(await recovered.submitPlayerText(
      `验证 ${options.mode} 已恢复。`, `mystery-drill:${options.mode}:recovery`,
    ))
    await recovered.deliver()
    return {
      mode: options.mode,
      initial: initialEvidence,
      recovery: {
        steps: options.mode === 'session-dead-letter'
          ? ['repair Session binding', 'retry dead letter', 'submit next Round']
          : ['restore Runtime Availability to ready', 'submit next Round'],
        playerResult: recoveryTurn.result,
        providerCalls: recovered.providerCalls,
        health: mysteryDrillBranchHealth(options.worldPath),
        audit: auditEvidence(options.worldPath),
      },
    }
  } finally {
    await recovered.close()
  }
}

export async function executeMysteryDrillCli(args: readonly string[]): Promise<string> {
  if (args.length !== 3 || !MODES.has(args[0] as MysteryDrillMode)
    || args.some(value => value.length === 0 || value.trim() !== value)) {
    throw new TypeError('usage: demo:mystery:drill <mode> <world.sqlite> <session.sqlite>')
  }
  if (existsSync(args[1]!) || existsSync(args[2]!)) {
    throw new TypeError('Mystery drill requires fresh world and Session paths')
  }
  const result = await runMysteryDrill({ mode: args[0] as MysteryDrillMode, worldPath: args[1]!, sessionPath: args[2]! })
  return Buffer.from(canonicalizeWorldJson(result as WorldJsonValue)).toString('utf8')
}
