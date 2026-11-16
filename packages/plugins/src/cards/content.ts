import { cardRewardState, CARD_CREDIT_LIMIT, type CardRewardConfig } from './rewards.ts'
import { nativeGameplay, type ContentGenerator } from '@perspectra/sdk'
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import { createCardActivity, scopedCardView, validateCardActivities } from './activity.ts'
import { colorRule } from './rules/colors.ts'
import { identityRule } from './rules/identity.ts'
import { auctionRule } from './rules/auction.ts'
import type { RulePack } from './engine.ts'
export const officialCardRules: readonly RulePack[] = [colorRule, identityRule, auctionRule]
const object = (value: unknown) => value as WorldJsonObject
export function createCardsContent(rulePacks: readonly RulePack[] = officialCardRules): ContentGenerator {
  return {
    id: 'official-cards',
    version: '1',
    dataVersion: 1,
    supportedDataVersions: [1],
    configFile: 'cards.json',
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['npcIds'],
      properties: {
        npcIds: { type: 'array', minItems: 2, maxItems: 8, uniqueItems: true, items: { type: 'string' } },
        seed: { type: 'integer', minimum: 1, maximum: 4294967295 },
        npcMode: { type: 'string', enum: ['model', 'deterministic'] },
        reward: {
          type: 'object',
          additionalProperties: false,
          required: ['rule', 'amount', 'minimumBid'],
          properties: {
            rule: { type: 'string', enum: ['auction'] },
            amount: { type: 'integer', minimum: 1, maximum: CARD_CREDIT_LIMIT },
            minimumBid: { type: 'integer', minimum: 0, maximum: 9 },
          },
        },
      },
    },
    validateConfig(raw, pack) {
      const config = raw as { npcIds: string[]; reward?: CardRewardConfig }
      if (config.reward && (!pack.playerId || !rulePacks.some(rule => rule.id === config.reward!.rule)))
        return [{ path: '/reward', message: '奖励需要玩家与所选竞价规则' }]
      return config.npcIds.flatMap((id, i) =>
        pack.characterIds.includes(id) && id !== pack.playerId
          ? []
          : [{ path: `/npcIds/${i}`, message: '必须是包内非玩家角色' }],
      )
    },
    generate(raw, pack) {
      const config = raw as {
        npcIds: string[]
        seed?: number
        npcMode?: 'model' | 'deterministic'
        reward?: CardRewardConfig
      }
      const scope = crypto.randomUUID().replaceAll('-', '').slice(0, 20)
      const activities = rulePacks.map(rule => ({
        key: `cards-${rule.id}`,
        activity: createCardActivity(
          rule,
          {
            ...config,
            ...(pack.playerId ? { playerId: pack.playerId } : {}),
            names: { ...pack.names },
            npcMode: config.npcMode ?? 'deterministic',
          },
          scope,
        ),
      }))
      const rules = new Map(rulePacks.map(rule => [`cards-${rule.id}`, rule]))
      const status = config.reward ? cardRewardState(pack.characterIds) : undefined
      const definition = nativeGameplay({
        id: 'official-cards',
        version: '1',
        dataVersion: 1,
        activities,
        ...(status ? { status } : {}),
      })
      return {
        ...(status ? { statusModules: [status] } : {}),
        gameplayConfig: {},
        activities,
        gameplay: [
          {
            ...definition,
            validateState: (_state, states) => validateCardActivities(states, rules),
            playerView: ({ activities: scoped = [] }) => {
              const current = scoped.find(row => object(row.game).active === true)
              if (!current) return {}
              return {
                stage: {
                  renderer: 'official-cards.table',
                  activityKey: String(current.activityKey),
                  activityId: String(current.id),
                  revision: Number(current.revision),
                  payload: scopedCardView(current) as WorldJsonObject,
                },
              }
            },
          },
        ],
      }
    },
  }
}
export const officialCardsContent = createCardsContent()
