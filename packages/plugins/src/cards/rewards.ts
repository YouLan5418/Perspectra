import type { GeneratedStatusModule } from '@perspectra/sdk'
import type { StatusTruth, WorldJsonObject } from '@perspectra/sdk/contracts'
import type { Table } from './engine.ts'

export const CARD_CREDIT = 'cards-credit'
export const CARD_CREDIT_LIMIT = 1_000_000
/** Author opt-in sample policy; the pure table knows neither world balances nor rewards. */
export interface CardRewardConfig {
  rule: 'auction'
  amount: number
  minimumBid: number
}
export function cardRewardState(characterIds: readonly string[]): GeneratedStatusModule {
  return {
    declaration: { id: 'cards', characters: [...characterIds] },
    module: {
      definition: {
        statuses: [
          {
            key: CARD_CREDIT,
            label: '纸灯积分',
            type: 'number',
            owner: 'character',
            schema: { type: 'number', minimum: 0, maximum: CARD_CREDIT_LIMIT, multipleOf: 1 },
            activities: ['cards-auction'],
            bar: true,
          },
        ],
        actions: [],
      },
      initialize(ids) {
        return { public: {}, characters: Object.fromEntries(ids.map(id => [id, { [CARD_CREDIT]: 0 }])) }
      },
      policy() {
        return { operations: [] }
      },
      resolve() {
        return { rejectReason: '积分只能随指定牌桌终局结算。' }
      },
    },
  }
}
/** Only a newly adjudicated, qualifying player victory proposes a reward, never opening/reading a save.
 * The enclosing native Activity result commits this proposal and the terminal table atomically.
 * Repeated inputs cannot cross the same nonterminal -> terminal boundary again.
 */
export function cardRewardResult(
  before: Table,
  next: Table,
  config: CardRewardConfig | undefined,
  playerId: string,
  truth: StatusTruth | null,
): WorldJsonObject | undefined {
  if (!config || before.result || !next.result || next.rule !== config.rule) return
  const player = next.seats.find(seat => seat.controller === playerId)
  if (!player || !next.result.winners.includes(player.id)) return
  const bid = (next.data.revealed as Record<string, number>)[player.id]
  if (bid === undefined || bid < config.minimumBid) return
  const balance = truth?.characters[playerId]?.[CARD_CREDIT]
  if (typeof balance !== 'number' || !Number.isSafeInteger(balance) || balance < 0)
    throw new Error('CARD_REWARD_BALANCE_INVALID')
  return {
    changes: [{ holderId: playerId, key: CARD_CREDIT, value: balance + config.amount }],
    reveals: [{ observerId: playerId, holderId: playerId, key: CARD_CREDIT }],
  }
}
