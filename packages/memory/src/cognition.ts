import {
  failWorld,
  type CharacterView,
  type WorldEventDraft,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'

function object(value: WorldJsonValue): WorldJsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as WorldJsonObject : undefined
}

/** Deterministic Observation-to-Claim derivation; it never reads hidden World Events. */
export class KnowledgeRule {
  derive(view: CharacterView): WorldEventDraft[] {
    const events: WorldEventDraft[] = []
    for (const observation of view.observations) {
      const value = object(observation.value)
      const candidateValue = value?.knowledgeCandidate
      const candidate = candidateValue === undefined ? undefined : object(candidateValue)
      if (candidate !== undefined) {
        if (typeof candidate.claimId !== 'string' || typeof candidate.proposition !== 'string') {
          throw new TypeError('knowledgeCandidate requires claimId and proposition')
        }
        events.push(this.#claim(candidate.claimId, view, candidate.proposition, observation.id, 'observed'))
        continue
      }
      const utteranceValue = value?.utterance
      const utterance = utteranceValue === undefined ? undefined : object(utteranceValue)
      if (utterance === undefined) continue
      if (typeof utterance.speakerId !== 'string' || typeof utterance.text !== 'string') {
        throw new TypeError('utterance requires speakerId and text')
      }
      events.push(this.#claim(
        `claim:said:${observation.id}`,
        view,
        `${utterance.speakerId} said: ${utterance.text}`,
        observation.id,
        'reported-speech',
      ))
    }
    return events
  }

  #claim(
    claimId: string,
    view: CharacterView,
    proposition: string,
    sourceObservationId: string,
    epistemicStatus: 'observed' | 'reported-speech',
  ): WorldEventDraft {
    return {
      eventType: 'claim.upsert',
      eventVersion: 1,
      data: {
        id: claimId,
        value: { characterId: view.characterId, proposition, sourceObservationId, epistemicStatus },
      },
    }
  }
}

export interface ReflectSourceRef extends WorldJsonObject {
  readonly kind: 'observation' | 'claim' | 'summary'
  readonly id: string
}

export interface CharacterReflectRequest extends WorldJsonObject {
  readonly claimId: string
  readonly proposition: string
  readonly sourceRefs: readonly ReflectSourceRef[]
  readonly correlationId: string
}

/** Validates character.reflect against the caller's current CharacterView only. */
export class CharacterReflectRule {
  resolve(view: CharacterView, request: CharacterReflectRequest): WorldEventDraft {
    if (request.claimId.length === 0 || request.proposition.length === 0) this.#reject(view, request, 'reflect requires claimId and proposition')
    if (request.sourceRefs.length === 0) this.#reject(view, request, 'reflect requires at least one cognitive source')
    const seen = new Set<string>()
    for (const source of request.sourceRefs) {
      const key = `${source.kind}:${source.id}`
      if (seen.has(key)) this.#reject(view, request, 'reflect sourceRefs must be unique')
      seen.add(key)
      if (source.kind === 'summary') this.#reject(view, request, 'Session Summary is not a cognitive source')
      const records = source.kind === 'observation' ? view.observations : view.claims
      if (!records.some(record => record.id === source.id)) this.#reject(view, request, 'reflect source is absent from CharacterView')
    }
    return {
      eventType: 'claim.upsert',
      eventVersion: 1,
      data: {
        id: request.claimId,
        value: {
          characterId: view.characterId,
          proposition: request.proposition,
          sourceRefs: request.sourceRefs,
          epistemicStatus: 'reflected',
        },
      },
    }
  }

  #reject(view: CharacterView, request: CharacterReflectRequest, message: string): never {
    failWorld({
      errorCode: 'ACTION_REJECTED',
      category: 'domain',
      message,
      retryable: false,
      correlationId: request.correlationId,
      address: view.address,
    })
  }
}
