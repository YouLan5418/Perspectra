import { randomUUID } from 'node:crypto'
import { brandId, resolutionAuthority, type WorldJsonObject, type WorldJsonValue, type CharacterId, type WorldAddress } from '@harness-world/contracts'
import { RulebookRegistry, currentCharacterLifecycle, rejectRulebookResolution, type CompiledWorldManifest,
  type RulebookResolver, type RulebookResolutionContext, type RulebookResolution } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { characterExecutionResult } from '../../packages/application/src/character-execution-result.ts'

const object = (value: WorldJsonValue | undefined): WorldJsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WorldJsonObject : undefined
const exact = (value: WorldJsonObject, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',')

/** Experimental one-shot delivery. This registry is never installed by the default host. */
export class CrossSceneCommunication {
  readonly contacts: ReadonlyMap<string, readonly string[]>
  readonly medium: string
  constructor(config: unknown, manifest: CompiledWorldManifest, private readonly base: RulebookResolver) {
    const root = object(config as WorldJsonValue)
    if (!root || !exact(root, ['medium', 'contacts']) || typeof root.medium !== 'string'
      || !root.medium.trim() || root.medium.length > 40) throw new TypeError('通信配置无效')
    const contacts = object(root.contacts)
    if (!contacts) throw new TypeError('通信联系人配置无效')
    const ids = new Set(manifest.characters.map(c => String(c.characterId)))
    this.contacts = new Map(Object.entries(contacts).map(([actor, recipients]) => {
      if (!ids.has(actor) || !Array.isArray(recipients) || new Set(recipients).size !== recipients.length
        || recipients.some(id => typeof id !== 'string' || id === actor || !ids.has(id))) throw new TypeError('通信联系人必须是已声明的其他角色')
      return [actor, [...recipients] as string[]]
    }))
    this.medium = root.medium
  }
  parameters(recipientId: string, text: string): WorldJsonObject {
    return { targetRef: { kind: 'character', id: recipientId }, bindingId: 'experiment:message',
      definitionRef: { id: 'experiment:message', version: 1 }, arguments: { text } }
  }
  resolver(): RulebookResolver {
    return {
      affordances: context => {
        const values = this.base.affordances(context)
        const contacts = this.contacts.get(String(context.characterId)) ?? []
        const options = currentCharacterLifecycle(context.events, String(context.characterId)) !== 'active' ? [] : contacts
          .filter(id => currentCharacterLifecycle(context.events, id) === 'active')
          .map(id => ({ ...this.parameters(id, ''), medium: this.medium,
            argumentSchema: { type: 'object', additionalProperties: false, required: ['text'],
              properties: { text: { type: 'string', minLength: 1, maxLength: context.publicationCharacters ?? 2000 } } } }))
        const interactions = [...values.filter(a => a.actionType === 'interact').flatMap(a => a.interactions ?? []), ...options]
        return [...values.filter(a => a.actionType !== 'interact'), ...(interactions.length ? [{ actionType: 'interact', actionVersion: 2, interactions }] : [])]
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
    const p = object(context.action.parameters)
    if (!p || (p.bindingId !== 'experiment:message' && object(p.definitionRef)?.id !== 'experiment:message')) return this.base.resolve(context)
    const reject = (reason: string) => ({ ...rejectRulebookResolution(String(context.characterId), 'interact', reason), observationScope: { scope: 'self' as const } })
    const target = object(p.targetRef), definition = object(p.definitionRef), args = object(p.arguments)
    if (context.action.actionType !== 'interact' || !exact(p, ['targetRef', 'bindingId', 'definitionRef', 'arguments'])
      || p.bindingId !== 'experiment:message' || !target || !exact(target, ['kind', 'id']) || target.kind !== 'character'
      || typeof target.id !== 'string' || !definition || !exact(definition, ['id', 'version'])
      || definition.id !== 'experiment:message' || definition.version !== 1 || !args || !exact(args, ['text'])
      || typeof args.text !== 'string' || !args.text.trim() || args.text.length > (context.publicationCharacters ?? 2000)) return reject('INVALID_COMMUNICATION')
    const actor = String(context.characterId)
    if (!(this.contacts.get(actor) ?? []).includes(target.id)) return reject('CONTACT_NOT_AUTHORIZED')
    if (currentCharacterLifecycle(context.events, actor) !== 'active' || currentCharacterLifecycle(context.events, target.id) !== 'active') return reject('CONTACT_UNAVAILABLE')
    if (!context.actionId) throw new TypeError('投递必须有行动标识')
    const speech = { characterId: actor, text: args.text, medium: this.medium, scope: 'direct', addresseeIds: [target.id] }
    // The receiving observation contains only the message, never the sender's scene or narration.
    return { status: 'accepted' as const, observationScope: { scope: 'self' as const }, events: [
      { eventType: 'character.speak', eventVersion: 1, data: speech },
      { eventType: 'observation.upsert', eventVersion: 1, data: { id: `${context.actionId}:message:${target.id}`,
        value: { observerId: target.id, actionId: context.actionId, content: {
          actorId: actor, actionType: 'interact', status: 'accepted', speech, resultDescription: `你收到一条${this.medium}；内容是发送者的陈述。` } } } },
    ] }
  }
  executionResult: typeof characterExecutionResult = input => object(input.action.parameters)?.bindingId === 'experiment:message'
    ? { status: input.status, description: input.status === 'accepted' ? `${this.medium}已投递，不代表对方已阅读或同意。` : `${this.medium}没有投递。` }
    : characterExecutionResult(input)

  /** Manual experiment input uses the same resolver and one short atomic world transaction. */
  async send(input: { store: WorldStore; leases: WriterLeaseService; address: WorldAddress; manifest: CompiledWorldManifest;
    actorId: CharacterId; recipientId: string; text: string; resolver?: RulebookResolver }) {
    return this.perform({ ...input, parameters: this.parameters(input.recipientId, input.text) })
  }
  async perform(input: { store: WorldStore; leases: WriterLeaseService; address: WorldAddress; manifest: CompiledWorldManifest;
    actorId: CharacterId; parameters: WorldJsonObject; resolver?: RulebookResolver }) {
    if (!input.manifest.playerBindings.some(binding => binding.characterId === input.actorId)) throw new TypeError('手动发送入口仅允许绑定玩家')
    const owner = `message:${randomUUID()}`, lease = input.leases.acquire(input.address, owner)
    try {
      const head = input.store.head(input.address), roundId = brandId(owner, 'InteractionRoundId'), actionId = `${owner}:action`
      const action = { actionType: 'interact', parameters: input.parameters }
      const result = (input.resolver ?? this).resolve({ manifest: input.manifest, events: input.store.readEvents(input.address), characterId: input.actorId, asOfWorldSeq: head.headSeq,
        actionId, roundId, action, resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate') })
      const speech = result.events.find(e => e.eventType === 'character.speak')
      await input.store.commitRound({ address: input.address, transactionId: brandId(owner, 'TransactionId'), roundId,
        expectedHeadSeq: head.headSeq, expectedTick: head.tick, nextTick: head.tick + 1, writerFencingToken: lease.fencingToken,
        correlationId: owner, authority: { actorId: input.actorId, action, status: result.status }, outbox: [], events: [
          ...result.events,
          { eventType: 'action.resolved', eventVersion: 1, data: { roundId, actionId, actorId: input.actorId, actionType: 'interact', sourceRole: 'player', accepted: result.status === 'accepted' } },
          { eventType: 'observation.upsert', eventVersion: 1, data: { id: `${actionId}:sender`, value: { observerId: input.actorId,
            content: { actorId: input.actorId, actionType: 'interact', status: result.status, ...(speech ? { speech: speech.data } : {}) } } } },
          { eventType: 'world.tick-advanced', eventVersion: 1, data: { tick: head.tick + 1, roundId } },
        ] })
      return { afterSeq: head.headSeq, status: result.status }
    } finally { input.leases.release(input.address, owner, lease.fencingToken) }
  }
}
