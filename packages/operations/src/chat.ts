import { createErrorEnvelope, canonicalizeWorldJson, type CharacterId, type WorldAddress, type WorldJsonValue } from '@harness-world/contracts'
import type { PlayerChatScope, SubmitTextResult, WorldApplication } from '@harness-world/application'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export type PersistentChatApplication = Pick<
  WorldApplication,
  'submitText' | 'characterViewForPrincipal' | 'roundStatus'
>

export interface PersistentWorldChatOptions {
  readonly idempotencyKey?: (ordinal: number, text: string) => string
  readonly health?: () => WorldJsonValue
}

export type WorldApplicationCliInvocation =
  | { readonly kind: 'chat'; readonly configArgs: readonly string[] }
  | { readonly kind: 'legacy'; readonly worldPath: string; readonly sessionPath: string; readonly command: readonly string[] }

export function parseWorldApplicationCliInvocation(argv: readonly string[]): WorldApplicationCliInvocation {
  if (argv[0] === 'chat') return { kind: 'chat', configArgs: argv.slice(1) }
  const [worldPath, sessionPath, ...command] = argv
  if (worldPath === undefined || sessionPath === undefined || command.length === 0) {
    throw new TypeError('usage: worldappctl chat [host options] | worldappctl <world.sqlite> <session.sqlite> <command>')
  }
  return { kind: 'legacy', worldPath, sessionPath, command }
}

export function selectPlayerChatScope(scopes: readonly PlayerChatScope[]): PlayerChatScope {
  if (scopes.length !== 1) {
    throw new TypeError(scopes.length === 0
      ? 'chat requires exactly one activated PlayerBinding'
      : 'chat found multiple PlayerBindings; use a dedicated data directory')
  }
  return scopes[0]!
}

function line(value: WorldJsonValue): string {
  return `${Buffer.from(canonicalizeWorldJson(value)).toString('utf8')}\n`
}

function controlResult(command: string, detail: WorldJsonValue = null): WorldJsonValue {
  return { type: 'control', command, detail }
}

/** Human-input, machine-stable stdio shell bound to exactly one PlayerBinding. */
export async function runPersistentWorldChat(
  input: Readable,
  output: Writable,
  application: PersistentChatApplication,
  scope: { readonly address: WorldAddress; readonly principalId: string; readonly characterId: CharacterId },
  options: PersistentWorldChatOptions = {},
): Promise<number> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  const makeKey = options.idempotencyKey ?? (() => `chat:${randomUUID()}`)
  let paused = false
  let ordinal = 0
  let handled = 0
  try {
    for await (const text of lines) {
      if (text.length === 0) continue
      if (text === '.exit') {
        output.write(line(controlResult('exit')))
        handled += 1
        break
      }
      if (text === '.pause') {
        paused = true
        output.write(line(controlResult('pause')))
        handled += 1
        continue
      }
      if (text === '.resume') {
        paused = false
        output.write(line(controlResult('resume')))
        handled += 1
        continue
      }
      if (paused) {
        output.write(line(controlResult('paused', { suggestion: '.resume' })))
        handled += 1
        continue
      }
      try {
        let result: WorldJsonValue
        if (text === '.view') {
          result = await application.characterViewForPrincipal(
            scope.address, scope.principalId, scope.characterId,
          ) as WorldJsonValue
        } else if (text === '.health') {
          result = options.health?.() ?? { status: 'unavailable' }
        } else if (text.startsWith('.round ')) {
          const idempotencyKey = text.slice('.round '.length)
          result = (await application.roundStatus(scope.address, { idempotencyKey }) ?? null) as WorldJsonValue
        } else if (text.startsWith('.')) {
          result = { status: 'clarification_required', reason: 'unknown shell command', candidates: ['.view', '.health', '.round', '.pause', '.exit'] }
        } else {
          ordinal += 1
          const idempotencyKey = makeKey(ordinal, text)
          const submitted: SubmitTextResult = await application.submitText(scope.address, {
            text,
            idempotencyKey,
            principalId: scope.principalId,
            correlationId: `chat:${idempotencyKey}`,
          })
          result = { type: 'player-input', idempotencyKey, result: submitted }
        }
        output.write(line(result))
      } catch (error: unknown) {
        output.write(line(createErrorEnvelope({
          errorCode: 'INVALID_REQUEST', category: 'admin', message: String(error), retryable: false,
          correlationId: `chat:${ordinal}`,
        }) as unknown as WorldJsonValue))
      }
      handled += 1
    }
  } finally {
    lines.close()
  }
  return handled
}
