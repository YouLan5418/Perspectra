import { randomUUID } from 'node:crypto'
import {
  brandId,
  resolutionAuthority,
  isMessageAction,
  type CharacterId,
  type WorldAddress,
  type WorldJsonObject,
} from '@harness-world/contracts'
import {
  RulebookRegistry,
  type CompiledWorldManifest,
  type RulebookResolver,
  type RulebookResolutionContext,
  type RulebookResolution,
} from '@harness-world/kernel'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import {
  actionObservations,
  CommunicationRules,
  characterExecutionResult,
  executeWorldRound,
} from '@harness-world/application'
import type { CommunicationInstance } from '@harness-world/plugin-sdk'
/** Bind computed message proposals to real contacts and the core execution path. */
export class CommunicationRuntime {
  readonly #rules: CommunicationRules
  constructor(
    readonly mechanism: CommunicationInstance,
    manifest: CompiledWorldManifest,
    private readonly base: RulebookResolver,
  ) {
    this.#rules = new CommunicationRules(
      mechanism.definition,
      manifest.characters.map(character => String(character.characterId)),
    )
  }
  get contacts() {
    return this.#rules.contacts
  }
  get medium() {
    return this.#rules.medium
  }
  get instruction() {
    return this.mechanism.instruction
  }
  parameters(recipientId: string, text: string) {
    const parameters = this.mechanism.parameters(recipientId, text)
    const request = this.#rules.request(parameters, 'interact', Infinity, true)
    if (!request || request.recipientId !== recipientId || request.text !== text)
      throw new TypeError('消息参数必须绑定请求的收件人与正文')
    return parameters
  }
  options(events: RulebookResolutionContext['events'], actorId: string, publicationCharacters = 2000) {
    const options = this.mechanism.options({
      actorId,
      recipientIds: this.#rules.activeContacts(events, actorId),
      publicationCharacters,
    })
    if (!Array.isArray(options)) throw new TypeError('通信选项必须是列表')
    for (const option of options) this.#rules.validateOption(option, actorId, events, publicationCharacters)
    return options
  }
  resolver(): RulebookResolver {
    return {
      affordances: context => {
        const values = this.base.affordances(context)
        const options = this.options(context.events, String(context.characterId), context.publicationCharacters)
        const interactions = [
          ...values.filter(a => a.actionType === 'interact').flatMap(a => a.interactions ?? []),
          ...options,
        ]
        return [
          ...values.filter(a => a.actionType !== 'interact'),
          ...(interactions.length ? [{ actionType: 'interact', actionVersion: 2, interactions }] : []),
        ]
      },
      resolve: context => this.resolve(context),
    }
  }
  registry(): RulebookRegistry {
    const registry = new RulebookRegistry()
    registry.register('builtin:speak-move', 2, this.resolver())
    return registry
  }
  resolve(context: RulebookResolutionContext): RulebookResolution {
    return isMessageAction(context.action.parameters)
      ? this.#rules.resolve(context, input => this.mechanism.prepare(input))
      : this.base.resolve(context)
  }
  executionResult: typeof characterExecutionResult = input =>
    isMessageAction(input.action.parameters)
      ? {
          status: input.status,
          description: this.mechanism.describeDelivery(input.status === 'accepted' ? 'accepted' : 'rejected'),
        }
      : characterExecutionResult(input)
  /** Manual experiment input uses the same resolver and one short atomic world transaction. */
  async send(input: {
    store: WorldStore
    leases: WriterLeaseService
    address: WorldAddress
    manifest: CompiledWorldManifest
    actorId: CharacterId
    recipientId: string
    text: string
    resolver?: RulebookResolver
    signal?: AbortSignal
  }) {
    return this.perform({ ...input, parameters: this.parameters(input.recipientId, input.text) })
  }
  async perform(input: {
    store: WorldStore
    leases: WriterLeaseService
    address: WorldAddress
    manifest: CompiledWorldManifest
    actorId: CharacterId
    parameters: WorldJsonObject
    resolver?: RulebookResolver
    signal?: AbortSignal
  }) {
    if (!input.manifest.playerBindings.some(binding => binding.characterId === input.actorId))
      throw new TypeError('手动发送入口仅允许绑定玩家')
    const owner = `message:${randomUUID()}`
    let status: RulebookResolution['status'] = 'rejected'
    const committed = await executeWorldRound(
      { ...input, owner, leaseTtlMs: 30_000, tickRoundId: true },
      ({ head, manifest, events }) => {
        const roundId = brandId(owner, 'InteractionRoundId'),
          actionId = `${owner}:action`
        const action = { actionType: 'interact', parameters: input.parameters }
        const result = (input.resolver ?? this).resolve({
          manifest,
          events,
          characterId: input.actorId,
          asOfWorldSeq: head.headSeq,
          actionId,
          roundId,
          action,
          resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate'),
        })
        status = result.status
        const speech = result.events.find(e => e.eventType === 'character.speak')
        return {
          authority: { actorId: input.actorId, action, status: result.status },
          events: [
            ...result.events,
            {
              eventType: 'action.resolved',
              eventVersion: 1,
              data: {
                roundId,
                actionId,
                actorId: input.actorId,
                actionType: 'interact',
                sourceRole: 'player',
                accepted: result.status === 'accepted',
              },
            },
            ...actionObservations({
              roundId,
              actionId,
              actorId: input.actorId,
              actionType: 'interact',
              status: result.status === 'accepted' ? 'accepted' : 'rejected',
              audience: { fullContentCharacterIds: [input.actorId], occurrenceOnlyCharacterIds: [] },
              shared: speech ? { speech: speech.data } : {},
              playerBindings: [],
              observationId: () => `${actionId}:sender`,
            }).events,
          ],
        }
      },
    )
    return { afterSeq: committed!.afterSeq, status }
  }
}
