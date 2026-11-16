import {
  MESSAGE_DEFINITION_ID,
  isMessageAction,
  parseCommunicationDefinition,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@perspectra/sdk/contracts'
import {
  currentCharacterLifecycle,
  rejectRulebookResolution,
  type RulebookResolutionContext,
  type RulebookResolution,
} from '@perspectra/core/kernel'
const object = (value: unknown): WorldJsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as WorldJsonObject) : undefined
const exact = (value: WorldJsonObject, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',')

/** Shared result validation, also used inside the selected provider's fault boundary. */
export function validateCommunicationCandidate(
  value: unknown,
  maximum: number,
): { rejectReason: string } | { text: string; description: string } {
  const candidate = object(value)
  if (
    candidate &&
    exact(candidate, ['rejectReason']) &&
    typeof candidate.rejectReason === 'string' &&
    candidate.rejectReason.trim()
  )
    return { rejectReason: candidate.rejectReason }
  if (
    !candidate ||
    !exact(candidate, ['text', 'description']) ||
    typeof candidate.text !== 'string' ||
    !candidate.text.trim() ||
    candidate.text.length > maximum ||
    typeof candidate.description !== 'string' ||
    candidate.description.length > 2000
  )
    throw new TypeError('通信机制返回了无效投递候选')
  return { text: candidate.text, description: candidate.description }
}

/** Message envelope validation shared by provider output guards and core request admission. */
export function parseCommunicationRequest(
  parameters: unknown,
  actionType: string,
  maximum: number,
  allowEmpty = false,
): { recipientId: string; text: string } | undefined {
  const p = object(parameters),
    target = object(p?.targetRef),
    definition = object(p?.definitionRef),
    args = object(p?.arguments)
  if (
    !p ||
    actionType !== 'interact' ||
    !exact(p, ['targetRef', 'bindingId', 'definitionRef', 'arguments']) ||
    p.bindingId !== MESSAGE_DEFINITION_ID ||
    !target ||
    !exact(target, ['kind', 'id']) ||
    target.kind !== 'character' ||
    typeof target.id !== 'string' ||
    !definition ||
    !exact(definition, ['id', 'version']) ||
    definition.id !== MESSAGE_DEFINITION_ID ||
    definition.version !== 1 ||
    !args ||
    !exact(args, ['text']) ||
    typeof args.text !== 'string' ||
    (!allowEmpty && !args.text.trim()) ||
    args.text.length > maximum
  )
    return undefined
  return { recipientId: target.id, text: args.text }
}
export function validateCommunicationOption(option: unknown, maximum: number): { recipientId: string; text: string } {
  const row = object(option)
  const request =
    row &&
    parseCommunicationRequest(
      {
        targetRef: row.targetRef!,
        bindingId: row.bindingId!,
        definitionRef: row.definitionRef!,
        arguments: row.arguments!,
      },
      'interact',
      maximum,
      true,
    )
  if (!request) throw new TypeError('通信机制提供了无效消息参数')
  return request
}

/** Contact authority, real sender binding and atomic delivery facts, independent of message computation. */
export class CommunicationRules {
  readonly contacts: ReadonlyMap<string, readonly string[]>
  readonly medium: string
  constructor(definition: unknown, characterIds: readonly string[]) {
    const root = parseCommunicationDefinition(definition)
    const contacts = root.contacts
    const ids = new Set(characterIds)
    this.contacts = new Map(
      Object.entries(contacts).map(([actor, recipients]) => {
        if (
          !ids.has(actor) ||
          !Array.isArray(recipients) ||
          new Set(recipients).size !== recipients.length ||
          recipients.some(id => typeof id !== 'string' || id === actor || !ids.has(id))
        )
          throw new TypeError('通信联系人必须是已声明的其他角色')
        return [actor, [...recipients] as string[]]
      }),
    )
    this.medium = root.medium
  }
  activeContacts(events: RulebookResolutionContext['events'], actorId: string): readonly string[] {
    if (currentCharacterLifecycle(events, actorId) !== 'active') return []
    return (this.contacts.get(actorId) ?? []).filter(id => currentCharacterLifecycle(events, id) === 'active')
  }
  request(
    parameters: WorldJsonValue | undefined,
    actionType: string,
    maximum: number,
    allowEmpty = false,
  ): { recipientId: string; text: string } | undefined {
    return parseCommunicationRequest(parameters, actionType, maximum, allowEmpty)
  }
  validateOption(
    option: WorldJsonObject,
    actorId: string,
    events: RulebookResolutionContext['events'],
    maximum: number,
  ): void {
    const request = this.request(
      {
        targetRef: option.targetRef!,
        bindingId: option.bindingId!,
        definitionRef: option.definitionRef!,
        arguments: option.arguments!,
      },
      'interact',
      maximum,
      true,
    )
    if (!request || !this.activeContacts(events, actorId).includes(request.recipientId))
      throw new TypeError('通信机制提供了未授权联系人或无效消息参数')
  }
  resolve(
    context: RulebookResolutionContext,
    prepare: (input: { actorId: string; recipientId: string; text: string; publicationCharacters: number }) => unknown,
    availableContacts?: readonly string[],
  ): RulebookResolution {
    if (!isMessageAction(context.action.parameters)) throw new TypeError('不是通信操作')
    const reject = (reason: string) => ({
      ...rejectRulebookResolution(String(context.characterId), 'interact', reason),
      observationScope: { scope: 'self' as const },
    })
    const maximum = context.publicationCharacters ?? 2000,
      request = this.request(context.action.parameters, context.action.actionType, maximum)
    if (!request) return reject('INVALID_COMMUNICATION')
    const actor = String(context.characterId),
      { recipientId } = request
    if (!(this.contacts.get(actor) ?? []).includes(recipientId)) return reject('CONTACT_NOT_AUTHORIZED')
    if (!this.activeContacts(context.events, actor).includes(recipientId)) return reject('CONTACT_UNAVAILABLE')
    if (availableContacts !== undefined && !availableContacts.includes(recipientId))
      return reject('CONTACT_UNAVAILABLE')
    if (!context.actionId) throw new TypeError('投递必须有行动标识')
    const candidate = validateCommunicationCandidate(
      prepare({ actorId: actor, recipientId, text: request.text, publicationCharacters: maximum }),
      maximum,
    )
    if ('rejectReason' in candidate) return reject(candidate.rejectReason)
    const speech = {
      characterId: actor,
      text: candidate.text,
      medium: this.medium,
      scope: 'direct',
      addresseeIds: [recipientId],
    }
    return {
      status: 'accepted',
      observationScope: { scope: 'self' },
      events: [
        { eventType: 'character.speak', eventVersion: 1, data: speech },
        {
          eventType: 'observation.upsert',
          eventVersion: 1,
          data: {
            id: `${context.actionId}:message:${recipientId}`,
            value: {
              observerId: recipientId,
              actionId: context.actionId,
              content: {
                actorId: actor,
                actionType: 'interact',
                status: 'accepted',
                speech,
                resultDescription: candidate.description,
              },
            },
          },
        },
      ],
    }
  }
}
