import {
  compareWorldText,
  hashWorldJson,
  type CharacterId,
  type WorldAddress,
  type WorldHash,
  type WorldJsonObject,
  type WorldJsonValue,
} from '@harness-world/contracts'
import type { WorldStore } from './world-store.ts'

const VISIBLE_STATE_EVENTS = [
  'character.visible-state-upserted',
  'character.visible-state-removed',
] as const

export interface CharacterVisibleStateRecord extends WorldJsonObject {
  readonly characterId: CharacterId
  readonly stateKey: string
  readonly channel: 'posture' | 'appearance'
  readonly description: string
  readonly sourceSeq: number
}

export interface CharacterVisibleStateBundle extends WorldJsonObject {
  readonly address: WorldAddress
  readonly asOfWorldSeq: number
  readonly states: readonly CharacterVisibleStateRecord[]
  readonly bundleHash: WorldHash
}

function object(value: WorldJsonValue, path: string): WorldJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  return value as WorldJsonObject
}

function stateIdentity(characterId: CharacterId, stateKey: string): string {
  return JSON.stringify([characterId, stateKey])
}

/** Rebuild current externally visible posture and appearance at one exact branch prefix. */
export class VisibleStateRebuilder {
  constructor(private readonly store: WorldStore) {}

  rebuildAt(address: WorldAddress, asOfWorldSeq: number, characterId?: CharacterId): CharacterVisibleStateBundle {
    if (!Number.isSafeInteger(asOfWorldSeq) || asOfWorldSeq < 0) {
      throw new RangeError('asOfWorldSeq must be a non-negative safe integer')
    }
    if (asOfWorldSeq > this.store.head(address).headSeq) {
      throw new RangeError('asOfWorldSeq cannot be later than the branch head')
    }
    const states = new Map<string, CharacterVisibleStateRecord>()
    for (const event of this.store.readEventsRange(address, 0, asOfWorldSeq, VISIBLE_STATE_EVENTS)) {
      const data = object(event.data, `${event.eventType}@${event.seq}`)
      if (typeof data.characterId !== 'string' || typeof data.stateKey !== 'string') {
        throw new TypeError(`${event.eventType} requires characterId and stateKey`)
      }
      const actor = data.characterId as CharacterId
      const identity = stateIdentity(actor, data.stateKey)
      if (event.eventType === 'character.visible-state-removed') {
        states.delete(identity)
        continue
      }
      const value = object(data.value as WorldJsonValue, `${event.eventType}@${event.seq}.value`)
      if ((value.channel !== 'posture' && value.channel !== 'appearance')
        || typeof value.description !== 'string' || value.description.length === 0) {
        throw new TypeError('character.visible-state-upserted value is malformed')
      }
      states.set(identity, {
        characterId: actor,
        stateKey: data.stateKey,
        channel: value.channel,
        description: value.description,
        sourceSeq: event.seq,
      })
    }
    const selected = [...states.values()]
      .filter(value => characterId === undefined || value.characterId === characterId)
      .sort((left, right) => compareWorldText(left.characterId, right.characterId)
        || compareWorldText(left.stateKey, right.stateKey))
    const base = { address, asOfWorldSeq, states: selected }
    return { ...base, bundleHash: hashWorldJson('character-visible-state-bundle/v1', base) }
  }
}
