import type { ActivityHooks } from '@perspectra/sdk'
import { canonicalizeWorldJson, type ActivityGame, type WorldJsonObject } from '@perspectra/sdk/contracts'
import { createTable, project, submit, validate, type Table, type RulePack, type Data } from './engine.ts'

export interface CardActivityConfig {
  npcIds: string[]
  names: Record<string, string>
  /** Optional reproducible demo seed. Otherwise one recorded Host draw seeds the pure engine. */
  seed?: number
  npcMode: 'model' | 'deterministic'
}
const object = (value: unknown) => value as WorldJsonObject
export const tableOf = (game: ActivityGame) => game.internal.table as unknown as Table

/** Only the trusted adapter sees the full table. All ordinary paths consume the same scoped projection. */
function toGame(table: Table, rule: RulePack): WorldJsonObject {
  const actors = [...new Set(table.seats.map(seat => seat.controller))]
  const pub = project(table, rule, '')
  return {
    active: table.result === null,
    phase: table.result ? 'finished' : 'playing',
    // Legacy Activity requires a participant turn even for simultaneous requests. Never used for admission.
    turn: table.result ? null : (table.seats.find(seat => seat.id === table.turnOwner)?.controller ?? actors[0]!),
    round: table.round,
    public: { table: pub as unknown as WorldJsonObject },
    private: Object.fromEntries(
      actors.map(actor => {
        const view = project(table, rule, actor)
        const zones = Object.fromEntries(
          Object.entries(view.zones as Data).filter(
            ([id]) =>
              table.zones[id]!.visibility === 'owner' &&
              table.seats.some(seat => seat.id === table.zones[id]!.owner && seat.controller === actor),
          ),
        )
        return [actor, { own: view.own!, zones }]
      }),
    ),
    internal: { table: table as unknown as WorldJsonObject },
  }
}
function ownChoices(scoped: WorldJsonObject): { seat: string; choices: { id: string; label: string }[] }[] {
  return (object(object(scoped.game).private).own ?? []) as unknown as {
    seat: string
    choices: { id: string; label: string }[]
  }[]
}
/** The scope is an instance admission capability, not persistent rule identity or deterministic game state. */
export function createCardActivity(rule: RulePack, config: CardActivityConfig, scope: string): ActivityHooks {
  const operation = `choose-${scope}`
  const schedule = (state: import('@perspectra/sdk/contracts').ActivityState): WorldJsonObject => {
    if (!state.game.active) return { kind: 'wait' }
    const table = tableOf(state.game)
    const seat = table.pending?.seats.find(id => !Object.hasOwn(table.pending!.answers, id))
    const actor = table.seats.find(row => row.id === seat)?.controller
    return actor && actor !== state.participants[0] ? { kind: 'activate', characterId: actor } : { kind: 'wait' }
  }
  return {
    definition: {
      title: rule.title,
      npcIds: config.npcIds,
      operations: [
        {
          id: operation,
          label: '提交牌桌选择',
          requiresTurn: false,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['request', 'seat', 'choice'],
            properties: {
              request: { type: 'string', minLength: 1, maxLength: 40 },
              seat: { type: 'string', minLength: 1, maxLength: 40 },
              choice: { type: 'string', minLength: 1, maxLength: 200 },
            },
          },
        },
      ],
    },
    phases: ['playing', 'finished'],
    initialize(input, random) {
      const actors = [String(input.playerId), ...(input.npcIds as string[])]
      const seats = actors.map((controller, index) => ({
        id: `seat-${index + 1}`,
        controller,
        label: config.names[controller] ?? controller,
      }))
      return toGame(createTable(rule, seats, config.seed ?? Math.floor(random() * 0x100000000)), rule)
    },
    policy(scoped) {
      return {
        speech: 'none',
        speechChoices: [],
        narration: false,
        move: false,
        interactions: [],
        operations: ownChoices(scoped).some(row => row.choices.length) ? [operation] : [],
      }
    },
    resolve(state, actor, requestedOperation, parameters) {
      if (requestedOperation !== operation) return { rejectReason: '牌桌操作所属实例已失效。' }
      const table = tableOf(state.game)
      try {
        const next = submit(table, rule, {
          actor,
          request: String(parameters.request),
          seat: String(parameters.seat),
          choice: String(parameters.choice),
        })
        const lines = next.log.slice(table.log.length)
        return {
          game: toGame(next, rule),
          description: lines.join('\n') || '牌桌选择已提交。',
          audience: 'participants',
        }
      } catch (error) {
        if (error instanceof Error && /^CARD_(UNAUTHORIZED|STALE_REQUEST|ILLEGAL_CHOICE)$/.test(error.message))
          return { rejectReason: error.message }
        throw error
      }
    },
    schedule,
    onOutcome(result, state) {
      const performed = object(result.performResult ?? {})
      return !result.failure && (result.status === 'published' || performed.status === 'accepted')
        ? schedule(state)
        : { kind: 'wait' }
    },
    simulate(request) {
      if (config.npcMode === 'model') return null
      if (object(request).continuation) return { decision: 'abstain' }
      const context = object(request.context),
        scoped = object(context.activity ?? {})
      if (!scoped.game) return { decision: 'abstain' }
      const own = ownChoices(scoped).find(row => row.choices.length)
      if (!own) return { decision: 'abstain' }
      const choice = own.choices[0]!
      const pending = object(object(object(scoped.game).public).table).request as WorldJsonObject
      return {
        decision: 'perform',
        actionType: 'interact',
        parameters: {
          targetRef: { kind: 'character', id: object(context.character).characterId! },
          bindingId: scoped.id!,
          definitionRef: { id: `activity:${operation}`, version: 1 },
          arguments: {
            activityId: scoped.id!,
            revision: scoped.revision!,
            request: pending.id!,
            seat: own.seat,
            choice: choice.id,
          },
        },
      }
    },
  }
}
export function validateCardActivities(
  activities: Readonly<Record<string, Readonly<import('@perspectra/sdk/contracts').ActivityState>>>,
  rules: ReadonlyMap<string, RulePack>,
): void {
  for (const [key, activity] of Object.entries(activities)) {
    const rule = rules.get(key)
    if (!rule) continue
    const table = tableOf(activity.game)
    validate(table, rule)
    if (table.seats.map(row => row.controller).join() !== activity.participants.join())
      throw new Error('CARD_PARTICIPANTS_MISMATCH')
    // Host suspend/escape are lifecycle wrappers; only compare the authoritative card projections.
    const expected = toGame(table, rule)
    const suspended = activity.suspendedTurn !== undefined
    const aborted = activity.game.phase === 'host-aborted'
    if (
      activity.game.round !== table.round ||
      (aborted && (activity.game.active || activity.game.turn !== null)) ||
      (suspended &&
        (activity.game.active ||
          activity.game.turn !== null ||
          activity.suspendedTurn !== expected.turn ||
          activity.game.phase !== expected.phase)) ||
      (!aborted &&
        !suspended &&
        (activity.game.active !== expected.active ||
          activity.game.turn !== expected.turn ||
          activity.game.phase !== expected.phase))
    )
      throw new Error('CARD_LIFECYCLE_MISMATCH')
    if (
      String(canonicalizeWorldJson(expected.public!)) !== String(canonicalizeWorldJson(activity.game.public)) ||
      String(canonicalizeWorldJson(expected.private!)) !== String(canonicalizeWorldJson(activity.game.private))
    )
      throw new Error('CARD_PROJECTION_MISMATCH')
  }
}
export function scopedCardView(scoped: WorldJsonObject): Data {
  const game = object(scoped.game)
  const pub = object(object(game.public).table) as unknown as Data,
    own = object(game.private)
  return {
    ...pub,
    zones: { ...(pub.zones as Data), ...(own.zones as unknown as Data) },
    own: (own.own as Data['own']) ?? [],
  }
}
