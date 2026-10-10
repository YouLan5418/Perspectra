import type { WorldJsonObject, WorldJsonValue, WorldEventDraft } from '@harness-world/contracts'
import { currentCharacterLifecycle, rejectRulebookResolution, type CompiledWorldManifest, type RulebookEvent,
  type RulebookResolver, type RulebookResolutionContext, type RulebookResolution } from '@harness-world/kernel'
import { CrossSceneCommunication } from './cross-scene-communication.ts'
import { characterExecutionResult } from '../../packages/application/src/character-execution-result.ts'

const object = (value: WorldJsonValue | undefined): WorldJsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WorldJsonObject : undefined
const exact = (value: WorldJsonObject, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',')
export type PhoneOperation = 'call' | 'accept' | 'decline' | 'say' | 'hangup'
export interface PhoneCall extends WorldJsonObject { callId: string; callerId: string; calleeId: string; state: 'ringing' | 'connected' | 'ended' }

/** Only committed connection facts are retained; there is no independent session database or background loop. */
export function phoneCalls(events: readonly RulebookEvent[]): PhoneCall[] {
  const calls = new Map<string, PhoneCall>()
  for (const event of events) {
    if (event.eventType !== 'communication.call-updated') continue
    const data = object(event.data)
    if (event.eventVersion !== 1 || !data || !exact(data, ['callId', 'callerId', 'calleeId', 'state'])
      || typeof data.callId !== 'string' || typeof data.callerId !== 'string' || typeof data.calleeId !== 'string'
      || data.callerId === data.calleeId || !['ringing', 'connected', 'ended'].includes(String(data.state))) throw new TypeError('通话事件损坏')
    const prior = calls.get(data.callId)
    if (prior ? prior.callerId !== data.callerId || prior.calleeId !== data.calleeId || prior.state === 'ended'
      || data.state === 'ringing' || prior.state === data.state : data.state !== 'ringing') throw new TypeError('通话事件次序损坏')
    calls.set(data.callId, data as PhoneCall)
  }
  return [...calls.values()]
}

export class CrossScenePhone extends CrossSceneCommunication {
  constructor(config: unknown, manifest: CompiledWorldManifest, private readonly phoneBase: RulebookResolver,
    private readonly nearby: (events: readonly RulebookEvent[], actor: string) => readonly string[]) { super(config, manifest, phoneBase) }
  callFor(events: readonly RulebookEvent[], actor: string): PhoneCall | undefined {
    const active = phoneCalls(events).filter(call => call.state !== 'ended' && [call.callerId, call.calleeId].includes(actor))
    if (active.length > 1) throw new TypeError('角色同时存在多个通话')
    return active[0]
  }
  phoneParameters(operation: PhoneOperation, peer: string, callId?: string, text?: string): WorldJsonObject {
    return { targetRef: { kind: 'character', id: peer }, bindingId: 'experiment:phone',
      definitionRef: { id: `experiment:phone-${operation}`, version: 1 }, arguments: {
        ...(callId === undefined ? {} : { callId }), ...(text === undefined ? {} : { text }) } }
  }
  override resolver(): RulebookResolver {
    return { resolve: context => this.resolve(context), affordances: context => {
      const base = this.phoneBase.affordances(context), actor = String(context.characterId), call = this.callFor(context.events, actor)
      const options: WorldJsonObject[] = []
      const offer = (operation: PhoneOperation, peer: string, id?: string) => options.push({
        ...this.phoneParameters(operation, peer, id, operation === 'say' ? '' : undefined), medium: this.medium,
        argumentSchema: { type: 'object', additionalProperties: false, required: [...(id === undefined ? [] : ['callId']), ...(operation === 'say' ? ['text'] : [])],
          properties: { ...(id === undefined ? {} : { callId: { type: 'string', const: id } }),
            ...(operation === 'say' ? { text: { type: 'string', minLength: 1, maxLength: context.publicationCharacters ?? 2000 } } : {}) } },
      })
      if (currentCharacterLifecycle(context.events, actor) === 'active') {
        if (!call) for (const peer of this.contacts.get(actor) ?? []) {
          if (currentCharacterLifecycle(context.events, peer) === 'active' && !this.callFor(context.events, peer)) offer('call', peer)
        }
        else {
          const peer = actor === call.callerId ? call.calleeId : call.callerId
          if (call.state === 'ringing' && actor === call.calleeId) { offer('accept', peer, call.callId); offer('decline', peer, call.callId) }
          if (call.state === 'connected' && currentCharacterLifecycle(context.events, peer) === 'active') offer('say', peer, call.callId)
          offer('hangup', peer, call.callId)
        }
      }
      const interactions = [...base.filter(a => a.actionType === 'interact').flatMap(a => a.interactions ?? []), ...options]
      return [...base.filter(a => a.actionType !== 'interact'), ...(interactions.length ? [{ actionType: 'interact', actionVersion: 2, interactions }] : [])]
    } }
  }
  override resolve(context: RulebookResolutionContext): RulebookResolution {
    const p = object(context.action.parameters), definition = object(p?.definitionRef)
    if (!p || (p.bindingId !== 'experiment:phone' && !String(definition?.id).startsWith('experiment:phone-'))) return this.phoneBase.resolve(context)
    const reject = (reason: string): RulebookResolution => ({ ...rejectRulebookResolution(String(context.characterId), 'interact', reason), observationScope: { scope: 'self' } })
    const target = object(p.targetRef), args = object(p.arguments)
    const operation = String(definition?.id).slice('experiment:phone-'.length) as PhoneOperation
    if (context.action.actionType !== 'interact' || !exact(p, ['targetRef', 'bindingId', 'definitionRef', 'arguments'])
      || p.bindingId !== 'experiment:phone' || !definition || !exact(definition, ['id', 'version']) || definition.version !== 1
      || !['call', 'accept', 'decline', 'say', 'hangup'].includes(operation) || !target || !exact(target, ['kind', 'id'])
      || target.kind !== 'character' || typeof target.id !== 'string' || !args
      || !exact(args, operation === 'call' ? [] : operation === 'say' ? ['callId', 'text'] : ['callId'])
      || operation !== 'call' && typeof args.callId !== 'string'
      || operation === 'say' && (typeof args.text !== 'string' || !args.text.trim() || args.text.length > (context.publicationCharacters ?? 2000))) return reject('INVALID_PHONE_OPERATION')
    if (!context.actionId) throw new TypeError('通话操作缺少行动标识')
    const actionId = context.actionId
    const actor = String(context.characterId), peer = target.id
    if (currentCharacterLifecycle(context.events, actor) !== 'active') return reject('ACTOR_CANNOT_ACT')
    let call: PhoneCall
    if (operation === 'call') {
      if (!(this.contacts.get(actor) ?? []).includes(peer)) return reject('CONTACT_NOT_AUTHORIZED')
      if (currentCharacterLifecycle(context.events, peer) !== 'active') return reject('CONTACT_UNAVAILABLE')
      if (this.callFor(context.events, actor) || this.callFor(context.events, peer)) return reject('PHONE_BUSY')
      call = { callId: `call:${context.actionId}`, callerId: actor, calleeId: peer, state: 'ringing' }
    } else {
      const current = phoneCalls(context.events).find(value => value.callId === args.callId)
      if (!current || ![current.callerId, current.calleeId].includes(actor)
        || peer !== (actor === current.callerId ? current.calleeId : current.callerId)) return reject('CALL_NOT_AUTHORIZED')
      if (current.state === 'ended') return reject('CALL_ENDED')
      if (operation === 'say' && current.state !== 'connected') return reject('CALL_NOT_CONNECTED')
      if ((operation === 'accept' || operation === 'decline') && (actor !== current.calleeId || current.state !== 'ringing')) return reject('CALL_NOT_RINGING')
      if ((operation === 'accept' || operation === 'say') && currentCharacterLifecycle(context.events, peer) !== 'active') return reject('CONTACT_UNAVAILABLE')
      call = { ...current, state: operation === 'accept' ? 'connected' : operation === 'decline' || operation === 'hangup' ? 'ended' : current.state }
    }
    const events: WorldEventDraft[] = []
    const observe = (id: string, content: WorldJsonObject) => events.push({ eventType: 'observation.upsert', eventVersion: 1,
      data: { id: `${actionId}:phone:${id}`, value: { observerId: id, actionId,
        content: { actorId: actor, actionType: 'interact', status: 'accepted', ...content } } } })
    if (operation === 'say') {
      const speech = { characterId: actor, text: args.text!, medium: this.medium, scope: 'direct', addresseeIds: [peer] }
      events.push({ eventType: 'character.speak', eventVersion: 1, data: speech })
      observe(peer, { speech, resultDescription: '你通过已接通的电话听见对方说话；这是对方的陈述。' })
      for (const bystander of this.nearby(context.events, actor).filter(id => id !== actor && id !== peer)) {
        observe(bystander, { speech: { characterId: actor, text: args.text!, medium: `${this.medium}本端` },
          resultDescription: '你在现场听见这个角色对着电话说话；你没有听见远端声音。' })
      }
    } else {
      events.push({ eventType: 'communication.call-updated', eventVersion: 1, data: call })
      for (const id of [actor, peer]) observe(id, { communication: { callId: call.callId, state: call.state, operation,
        peerId: id === actor ? peer : actor }, resultDescription: operation === 'call' ? (id === peer ? '你收到电话呼叫，可以自主接听、拒接或不处理。' : '呼叫已发出，对方尚未接听。')
          : call.state === 'connected' ? '电话已接通，可以通过通话交互说话，也可以挂断。' : '电话已结束，不能继续通过这次连接传递声音。' })
    }
    return { status: 'accepted', events, observationScope: { scope: 'self' } }
  }
  override executionResult: typeof characterExecutionResult = input => object(input.action.parameters)?.bindingId === 'experiment:phone'
    ? { status: input.status, description: input.status !== 'accepted' ? '这次通话操作未完成；没有投递声音或改变连接。'
      : object(input.action.parameters)?.definitionRef && String(object(object(input.action.parameters)?.definitionRef)?.id).endsWith('-say')
        ? '话语已通过电话传递；本地旁观者也可能听见你的这一端声音。' : '通话操作已提交；请以刷新后的可用操作判断连接是否接通或结束。' }
    : characterExecutionResult(input)
}
