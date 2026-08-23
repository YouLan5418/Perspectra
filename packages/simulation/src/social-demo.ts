import { WorldApplication, type RoundParticipant } from '@harness-world/application'
import { brandId, type AgentProvider, type CharacterView } from '@harness-world/contracts'
import { WorldSpecCompiler, type CompiledWorldSpec } from '@harness-world/kernel'

export const SOCIAL_DEMO_IDS = {
  player: brandId('character:visitor', 'CharacterId'),
  merchant: brandId('character:merchant', 'CharacterId'),
} as const

export function compileSocialDemo(): CompiledWorldSpec {
  return new WorldSpecCompiler().compile({
    schemaVersion: 2,
    address: { tenantId: 'tenant:reference', worldId: 'world:courtyard-social', branchId: 'branch:main' },
    metadata: { title: '庭院闲谈', description: '不含调查规则的通用社交验收切片' },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
    locations: [
      { locationId: 'location:courtyard', name: '庭院' },
      { locationId: 'location:garden', name: '花园' },
    ],
    entities: [{ entityId: 'entity:tea-cup', locationId: 'location:courtyard', kind: 'cup' }],
    characters: [
      { characterId: SOCIAL_DEMO_IDS.player, name: '访客', locationId: 'location:courtyard' },
      { characterId: SOCIAL_DEMO_IDS.merchant, name: '商人', locationId: 'location:courtyard' },
    ],
    scenes: [{ sceneId: 'scene:courtyard-chat', participantIds: [SOCIAL_DEMO_IDS.player, SOCIAL_DEMO_IDS.merchant] }],
    goals: [],
    claims: [{
      claimId: 'claim:merchant-private-price', characterId: SOCIAL_DEMO_IDS.merchant,
      value: { proposition: '最低成交价是七枚银币。' },
    }],
    observations: [],
    playerBindings: [{
      principalId: 'principal:visitor', characterId: SOCIAL_DEMO_IDS.player, sessionId: 'session:visitor',
    }],
    plugins: [
      { pluginId: 'builtin:agent-context', version: '2.0.0' },
      { pluginId: 'builtin:scene-decision', version: '1.0.0' },
    ],
  })
}

export interface SocialDemoSnapshot {
  readonly tick: number
  readonly playerView: CharacterView
  readonly merchantView: CharacterView
  readonly eventTypes: readonly string[]
}

/** A second-genre reference slice proving that the formal path is not mystery-specific. */
export class SocialDemoScenario {
  readonly compiled = compileSocialDemo()
  readonly #application: WorldApplication
  #providerCalls = 0

  constructor(options: { readonly worldPath: string; readonly sessionPath: string; readonly memoryPath?: string }) {
    const provider: AgentProvider = {
      propose: async context => {
        this.#providerCalls += 1
        return {
          participantId: 'agent:merchant',
          actions: [{
            actionId: `action:merchant-greeting:${context.roundId}`,
            actorId: SOCIAL_DEMO_IDS.merchant,
            actionType: 'speak',
            actionVersion: 1,
            parameters: { text: '天气不错，要看看新到的茶具吗？' },
          }],
        }
      },
    }
    const participant: RoundParticipant = {
      participantId: 'agent:merchant', role: 'agent', actorId: SOCIAL_DEMO_IDS.merchant,
      allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100, provider,
    }
    this.#application = new WorldApplication({
      ...options,
      memoryPath: options.memoryPath ?? `${options.worldPath}.memory.sqlite`,
      modelBudgetTokens: 4,
      participants: () => [participant],
    })
  }

  get providerCalls(): number { return this.#providerCalls }

  activate() { return this.#application.activate(this.compiled) }

  submitText(text: string, idempotencyKey: string) {
    this.activate()
    return this.#application.submitText(this.compiled.manifest.address, {
      text, idempotencyKey, principalId: 'principal:visitor', correlationId: idempotencyKey,
    })
  }

  async snapshot(): Promise<SocialDemoSnapshot> {
    const address = this.compiled.manifest.address
    const [head, playerView, merchantView, events] = await Promise.all([
      this.#application.head(address),
      this.#application.characterView(address, SOCIAL_DEMO_IDS.player),
      this.#application.characterView(address, SOCIAL_DEMO_IDS.merchant),
      this.#application.eventHistory(address),
    ])
    return { tick: head.tick, playerView, merchantView, eventTypes: events.map(event => event.eventType) }
  }

  close(): Promise<void> { return this.#application.close() }
}
