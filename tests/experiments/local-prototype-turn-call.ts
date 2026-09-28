import type { WorldJsonObject } from '@harness-world/contracts'
import { prototypeTurnCall } from '@harness-world/provider-chat'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'

/** The local Gemini gateway treats a root oneOf as if only its first choice were available. */
export function localPrototypeTurnCall(request: PrototypeTurnRequest) {
  const prepared = prototypeTurnCall(request)
  const canPerform = request.canPerform ?? !request.continuation
  const affordances = Array.isArray(request.context.affordances)
    ? request.context.affordances as WorldJsonObject[] : []
  const move = canPerform ? affordances.find(entry => entry.actionType === 'move') : undefined
  const interact = canPerform ? affordances.find(entry => entry.actionType === 'interact') : undefined
  const destinations = Array.isArray(move?.destinations) ? move.destinations as WorldJsonObject[] : []
  const choices = Array.isArray(interact?.interactions) ? interact.interactions as WorldJsonObject[] : []
  const actionTypes = [ ...(move === undefined ? [] : ['move']), ...(choices.length === 0 ? [] : ['interact']) ]
  const people = (request.context.scene as WorldJsonObject | undefined)?.people
  const actorId = (request.context.character as WorldJsonObject | undefined)?.characterId
  const addressees = Array.isArray(people) ? people.flatMap(person => {
    const id = (person as WorldJsonObject).characterId
    return typeof id === 'string' && id !== actorId ? [id] : []
  }) : []
  const interactionIds = choices.map(choice => choice.targetRef as WorldJsonObject)
  const definitions = choices.map(choice => choice.definitionRef as WorldJsonObject)
  const parameterProperties: WorldJsonObject = {
    ...(move === undefined ? {} : { locationId: { type: 'string',
      ...(destinations.length === 0 ? {} : { enum: destinations.map(place => place.locationId).filter((id): id is string => typeof id === 'string') }),
      description: 'move 时填写目的地 locationId，不要填写 destinationId。' } }),
    ...(choices.length === 0 ? {} : {
      targetRef: { type: 'object', additionalProperties: false, required: ['kind', 'id'],
        properties: { kind: { type: 'string', enum: [...new Set(interactionIds.map(ref => ref.kind).filter((id): id is string => typeof id === 'string'))] },
          id: { type: 'string', enum: interactionIds.map(ref => ref.id).filter((id): id is string => typeof id === 'string') } } },
      bindingId: { type: 'string', enum: choices.map(choice => choice.bindingId).filter((id): id is string => typeof id === 'string') },
      definitionRef: { type: 'object', additionalProperties: false, required: ['id', 'version'],
        properties: { id: { type: 'string', enum: [...new Set(definitions.map(ref => ref.id).filter((id): id is string => typeof id === 'string'))] },
          version: { type: 'integer', enum: [...new Set(definitions.map(ref => ref.version).filter((version): version is number => typeof version === 'number'))] } } },
      arguments: { type: 'object' },
    }),
  }
  return { ...prepared,
    schema: { type: 'object', additionalProperties: false, required: ['decision'], properties: {
      decision: { type: 'string', enum: ['abstain', 'publish',
        ...(request.canRecall === true ? ['recall'] : []), ...(actionTypes.length > 0 ? ['perform'] : [])],
        description: 'publish 需要 speech 或 narration；recall 需要 query；perform 需要 actionType 和 parameters。' },
      speech: { type: 'string', maxLength: 2000 }, narration: { type: 'string', maxLength: 2000 },
      ...(addressees.length === 0 ? {} : { addresseeIds: { type: 'array', uniqueItems: true,
        items: { type: 'string', enum: addressees } } }),
      ...(request.canRecall === true ? { query: { type: 'string', minLength: 2, maxLength: 120 } } : {}),
      ...(actionTypes.length === 0 ? {} : { actionType: { type: 'string', enum: actionTypes },
        parameters: { type: 'object', additionalProperties: false, properties: parameterProperties,
          description: 'move 只填 locationId；interact 复制 context.affordances 中同一个选项的 targetRef、bindingId、definitionRef 和 arguments。' } }),
    } },
  }
}
