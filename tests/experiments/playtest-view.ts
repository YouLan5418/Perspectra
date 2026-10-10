import { publicationSegments, type WorldJsonObject } from '@harness-world/contracts'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { compareWorldText, type CharacterId, type CharacterView } from '@harness-world/contracts'
import type { CompiledWorldManifest } from '@harness-world/kernel'
import type { PlaytestState } from './playtest-server.ts'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function manifestationText(value: unknown): string | undefined {
  const manifestation = object(value)
  if (typeof manifestation?.description === 'string' && manifestation.description.length > 0) {
    return manifestation.description
  }
  if (!Array.isArray(manifestation?.cues)) return undefined
  const descriptions = manifestation.cues.flatMap(cue => {
    const description = object(cue)?.description
    return typeof description === 'string' && description.length > 0 ? [description] : []
  })
  return descriptions.length === 0 ? undefined : descriptions.join('，')
}

export function playtestModelCharacters(
  manifest: CompiledWorldManifest,
  playerId: CharacterId,
): readonly { readonly actorId: CharacterId; readonly name: string }[] {
  return manifest.characters
    .filter(character => character.characterId !== playerId)
    .filter(character => !('lifecycle' in character) || character.lifecycle === 'active')
    .filter(character => !('controllerClass' in character) || character.controllerClass !== 'manual')
    .sort((left, right) => compareWorldText(left.characterId, right.characterId))
    .map(character => ({
      actorId: character.characterId,
      name: character.name,
    }))
}

export function playerTranscript(
  view: CharacterView,
  names: ReadonlyMap<string, string>,
  playerId: CharacterId,
): PlaytestState['transcript'] {
  return view.observations.flatMap(observation => {
    const content = object(object(observation.value)?.content)
    const speech = object(content?.speech)
    const stage = typeof speech?.narration === 'string' && speech.narration.length > 0
      ? speech.narration : manifestationText(content?.manifestation)
    if (content?.status !== 'accepted') return []
    if (typeof speech?.characterId !== 'string' || (typeof speech.text !== 'string' && speech.segments === undefined)) {
      if (content?.actionType === 'interact' && typeof content.actorId === 'string') {
        const transfer = object(content.interaction)
        if (typeof transfer?.entityId !== 'string') {
          return typeof content.resultDescription === 'string' && content.resultDescription.trim() ? [{seq: observation.sourceSeq,
            speaker: object(content.activity) || object(object(content.resultMetadata)?.activity) ? '游戏结果' : names.get(content.actorId) ?? content.actorId,
            text: content.resultDescription, player: false}] : []
        }
        const item = transfer.entityId
        const destination = transfer.toHolderId === null ? '解除个人保管，留在当前场所' : `交由${names.get(String(transfer.toHolderId)) ?? transfer.toHolderId}保管`
        return [{ seq: observation.sourceSeq, speaker: names.get(content.actorId) ?? content.actorId, text: `${item} 已${destination}。`, player: content.actorId === playerId }]
      }
      if ((content?.actionType !== 'move' && content?.actionType !== 'take') || typeof content.actorId !== 'string') return []
      const actionText = content.actionType === 'move' ? '移动到了另一个地点。' : '拿取了一个物品。'
      return [{
        seq: observation.sourceSeq,
        speaker: names.get(content.actorId) ?? content.actorId,
        text: stage === undefined ? actionText : `（${stage}）\n${actionText}`,
        player: content.actorId === playerId,
      }]
    }
    const segments = speech.segments === undefined ? undefined
      : publicationSegments(speech as WorldJsonObject).filter(segment => segment.text.trim())
    return [{
      seq: observation.sourceSeq,
      speaker: (names.get(speech.characterId) ?? speech.characterId) + (typeof speech.medium === 'string' ? `（${speech.medium}）` : ''),
      ...(segments === undefined ? {} : { segments }),
      text: segments !== undefined ? segments.map(segment => segment.type === 'narration' ? `（${segment.text}）` : segment.text).join('\n') : stage === undefined ? speech.text as string : [`（${stage}）`, speech.text].filter(Boolean).join('\n'),
      player: speech.characterId === playerId,
    }]
  }).sort((left, right) => left.seq - right.seq)
}

export function defaultPlaytestDirectory(): string {
  const configured = process.env.HCW_PLAYTEST_DATA_DIRECTORY?.trim()
  if (configured) return resolve(configured)
  let candidate: string
  do {
    candidate = resolve('.tmp', `web-playtest-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`)
  } while (existsSync(candidate))
  return candidate
}
