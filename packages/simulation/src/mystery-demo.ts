import {
  WorldApplication,
  type RoundParticipant,
} from '@harness-world/application'
import {
  brandId,
  deterministicId,
  type CharacterId,
  type CharacterView,
  type StoredRoundAuthority,
  type WorldHash,
  type WorldJsonObject,
} from '@harness-world/contracts'
import {
  currentEntityState,
  WorldSpecCompiler,
  type CompiledWorldSpec,
  type EntityState,
  type PlayerRoundResult,
} from '@harness-world/kernel'

export const MYSTERY_DEMO_IDS = {
  tenantId: 'tenant:mystery-demo',
  worldId: 'world:ashgrove-murder',
  branchId: 'branch:main',
  player: 'character:player',
  alice: 'character:alice',
  bob: 'character:bob',
  detective: 'character:detective',
  key: 'entity:study-key',
  scene: 'scene:study-investigation',
} as const

/** The versioned, no-network authoring input for the V0 three-role mystery fixture. */
export function createMysteryDemoSpec(): WorldJsonObject {
  return {
    schemaVersion: 2,
    address: {
      tenantId: MYSTERY_DEMO_IDS.tenantId,
      worldId: MYSTERY_DEMO_IDS.worldId,
      branchId: MYSTERY_DEMO_IDS.branchId,
    },
    metadata: {
      title: '灰林宅邸疑案',
      description: 'Bob 隐瞒真相，Alice、侦探与玩家从不同知识起点调查同一现场。',
    },
    timeMode: 'TURN_DRIVEN',
    roundQueueLimit: 8,
    runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
    rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
    locations: [
      { locationId: 'location:drawing-room', name: '会客厅' },
      { locationId: 'location:study', name: '书房' },
    ],
    entities: [{ entityId: MYSTERY_DEMO_IDS.key, locationId: 'location:study', kind: 'key' }],
    characters: [
      { characterId: MYSTERY_DEMO_IDS.player, name: '调查参与者', locationId: 'location:study' },
      { characterId: MYSTERY_DEMO_IDS.alice, name: 'Alice', locationId: 'location:study' },
      { characterId: MYSTERY_DEMO_IDS.bob, name: 'Bob', locationId: 'location:study' },
      { characterId: MYSTERY_DEMO_IDS.detective, name: '侦探', locationId: 'location:study' },
    ],
    scenes: [{
      sceneId: MYSTERY_DEMO_IDS.scene,
      participantIds: [
        MYSTERY_DEMO_IDS.player, MYSTERY_DEMO_IDS.alice,
        MYSTERY_DEMO_IDS.bob, MYSTERY_DEMO_IDS.detective,
      ],
    }],
    goals: [
      {
        goalId: 'goal:alice-assist-and-protect', characterId: MYSTERY_DEMO_IDS.alice,
        value: { status: 'active', priority: 60, visibility: 'private', intent: '协助调查，同时保护自己信任的人' },
      },
      {
        goalId: 'goal:bob-conceal-and-control', characterId: MYSTERY_DEMO_IDS.bob,
        value: { status: 'active', priority: 100, visibility: 'private', intent: '避免身份暴露，并控制不利证据' },
      },
      {
        goalId: 'goal:detective-identify-culprit', characterId: MYSTERY_DEMO_IDS.detective,
        value: { status: 'active', priority: 90, visibility: 'private', intent: '根据证据查明凶手身份' },
      },
      {
        goalId: 'goal:player-find-truth', characterId: MYSTERY_DEMO_IDS.player,
        value: { status: 'active', priority: 80, visibility: 'private', intent: '参与调查并查明真相' },
      },
    ],
    claims: [
      {
        claimId: 'claim:bob-private-culprit-knowledge', characterId: MYSTERY_DEMO_IDS.bob,
        value: {
          epistemicStatus: 'known', visibility: 'private', source: 'author-secret',
          proposition: { subject: MYSTERY_DEMO_IDS.bob, predicate: 'is_culprit', object: true },
        },
      },
      {
        claimId: 'claim:detective-suspects-bob', characterId: MYSTERY_DEMO_IDS.detective,
        value: {
          epistemicStatus: 'suspected', visibility: 'private', source: 'prior-investigation',
          proposition: { subject: MYSTERY_DEMO_IDS.bob, predicate: 'may_be_involved', object: true },
        },
      },
      {
        claimId: 'claim:alice-trusts-bob', characterId: MYSTERY_DEMO_IDS.alice,
        value: {
          epistemicStatus: 'believed', visibility: 'private', source: 'prior-relationship',
          proposition: { subject: MYSTERY_DEMO_IDS.bob, predicate: 'is_trustworthy', object: true },
        },
      },
    ],
    observations: [
      {
        observationId: 'observation:alice-key', observerId: MYSTERY_DEMO_IDS.alice,
        value: { subject: MYSTERY_DEMO_IDS.key, perception: '黄铜钥匙在书桌上', interpretation: '普通线索' },
      },
      {
        observationId: 'observation:bob-key', observerId: MYSTERY_DEMO_IDS.bob,
        value: { subject: MYSTERY_DEMO_IDS.key, perception: '黄铜钥匙在书桌上', interpretation: '必须控制的不利证据' },
      },
      {
        observationId: 'observation:detective-key', observerId: MYSTERY_DEMO_IDS.detective,
        value: { subject: MYSTERY_DEMO_IDS.key, perception: '黄铜钥匙在书桌上', interpretation: '可能与案件有关的证据' },
      },
      {
        observationId: 'observation:player-key', observerId: MYSTERY_DEMO_IDS.player,
        value: { subject: MYSTERY_DEMO_IDS.key, perception: '黄铜钥匙在书桌上', interpretation: '尚未检验的线索' },
      },
    ],
    playerBindings: [{
      principalId: 'principal:mystery-player', characterId: MYSTERY_DEMO_IDS.player, sessionId: 'session:mystery-player',
    }],
    plugins: [],
  }
}

export function compileMysteryDemo(): CompiledWorldSpec {
  return new WorldSpecCompiler().compile(createMysteryDemoSpec())
}

export interface MysteryDemoScenarioOptions {
  readonly worldPath: string
  readonly sessionPath: string
}

export interface MysteryDemoSnapshot {
  readonly headSeq: number
  readonly tick: number
  readonly entity: EntityState
  readonly views: Readonly<Record<'player' | 'alice' | 'bob' | 'detective', CharacterView>>
  readonly eventHashes: readonly WorldHash[]
  readonly authority: StoredRoundAuthority | null
}

/** Fail closed when an author/debug snapshot cannot bind expected authority state. */
export function requireMysterySnapshotValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Mystery Demo snapshot is missing ${label}`)
  return value
}

/** Scripted Scenario Runner for the first deterministic mystery turn. */
export class MysteryDemoScenario {
  readonly compiled = compileMysteryDemo()
  readonly #application: WorldApplication
  #bobProviderCalls = 0
  #directorProviderCalls = 0

  constructor(private readonly options: MysteryDemoScenarioOptions) {
    this.#application = new WorldApplication({
      ...options,
      runtimeOwnerId: 'mystery-demo',
      modelBudgetTokens: 4,
      participants: () => this.#participants(),
    })
  }

  get providerCalls(): { readonly bob: number; readonly director: number } {
    return { bob: this.#bobProviderCalls, director: this.#directorProviderCalls }
  }

  activate() {
    return this.#application.activate(this.compiled)
  }

  async runOpeningTurn(): Promise<PlayerRoundResult> {
    this.activate()
    return this.#application.submit(this.compiled.manifest.address, {
      idempotencyKey: 'mystery-demo:opening',
      principalId: 'principal:mystery-player',
      action: { actionType: 'speak', parameters: { text: '我们从书房开始调查。' } },
      correlationId: 'mystery-demo:opening',
    })
  }

  async deliver(): Promise<number> {
    return this.#application.deliver(this.compiled.manifest.address, 'mystery-demo:deliver')
  }

  async snapshot(): Promise<MysteryDemoSnapshot> {
    const address = this.compiled.manifest.address
    const head = await this.#application.head(address)
    const character = (id: string): CharacterId => brandId(id, 'CharacterId')
    const [player, alice, bob, detective] = await Promise.all([
      this.#application.characterView(address, character(MYSTERY_DEMO_IDS.player), head.headSeq),
      this.#application.characterView(address, character(MYSTERY_DEMO_IDS.alice), head.headSeq),
      this.#application.characterView(address, character(MYSTERY_DEMO_IDS.bob), head.headSeq),
      this.#application.characterView(address, character(MYSTERY_DEMO_IDS.detective), head.headSeq),
    ])
    const events = await this.#application.eventHistory(address, head.headSeq)
    const taken = [...events].reverse().find(event => event.eventType === 'entity.taken')
    const authority = taken === undefined
      ? null
      : requireMysterySnapshotValue(
        await this.#application.roundAuthority(address, taken.transactionId),
        `Round Authority ${taken.transactionId}`,
      )
    return {
      headSeq: head.headSeq,
      tick: head.tick,
      entity: requireMysterySnapshotValue(currentEntityState(events, MYSTERY_DEMO_IDS.key), `entity ${MYSTERY_DEMO_IDS.key}`),
      views: { player, alice, bob, detective },
      eventHashes: events.map(event => event.eventHash),
      authority,
    }
  }

  async close(): Promise<void> {
    await this.#application.close()
  }

  #participants(): readonly RoundParticipant[] {
    return [
      {
        participantId: 'agent:bob', role: 'agent', actorId: brandId(MYSTERY_DEMO_IDS.bob, 'CharacterId'),
        allowedActionTypes: ['take'], priority: 100, estimatedTokens: 1, timeoutMs: 100,
        provider: {
          propose: async (context) => {
            this.#bobProviderCalls += 1
            return {
              participantId: 'agent:bob',
              actions: [{
                actionId: deterministicId('action:mystery-bob-take-key', { roundId: context.roundId }),
                actorId: brandId(MYSTERY_DEMO_IDS.bob, 'CharacterId'),
                actionType: 'take', actionVersion: 1, parameters: { entityId: MYSTERY_DEMO_IDS.key },
              }],
            }
          },
        },
      },
      {
        participantId: 'director:detective-observer', role: 'director', actorId: brandId(MYSTERY_DEMO_IDS.detective, 'CharacterId'),
        allowedActionTypes: [], priority: 10, estimatedTokens: 1, timeoutMs: 100,
        provider: {
          propose: async () => {
            this.#directorProviderCalls += 1
            return { participantId: 'director:detective-observer', actions: [] }
          },
        },
      },
    ]
  }
}
