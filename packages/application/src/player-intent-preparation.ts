import { deterministicId, hashWorldJson, resolutionAuthority,
  type PlayerSubmissionV2, type WorldHash, type WorldJsonObject } from '@harness-world/contracts'
import { parsePlayerActionInput, type CompiledWorldManifest, type RulebookEvent, type RulebookResolver } from '@harness-world/kernel'
import type { PlayerInputJob } from '@harness-world/store-sqlite'
import { PlayerInputInterpreter } from './player-input.ts'
import type { PlayerIntentProfile, PreparedPlayerIntent } from './player-intent-worker.ts'

/** Called only after PlayerBinding authorization, on the head selected by the durable input FIFO. */
export function preparePlayerIntent(job: PlayerInputJob, manifest: CompiledWorldManifest, events: readonly RulebookEvent[],
  resolver: RulebookResolver, _profile: PlayerIntentProfile | undefined, _budget: number,
  manifestHash: WorldHash, asOfWorldSeq: number):
  PreparedPlayerIntent | { directSubmission: PlayerSubmissionV2 } | { clarification: string } {
  const actor = manifest.playerBindings.find(value => value.principalId === job.principalId)
  if (actor === undefined) throw new TypeError('player input lost its PlayerBinding')
  const input = job.input as WorldJsonObject
  const sourceText = input.text as string
  const context = { manifest, events, characterId: actor.characterId, manifestHash, asOfWorldSeq,
    resolutionAuthority: resolutionAuthority('player', 'manual_player_immediate') }
  const afforded = resolver.affordances(context)
  const explicit = Object.hasOwn(input, 'action') ? { status: 'resolved' as const, action: parsePlayerActionInput(input.action!) }
    : new PlayerInputInterpreter().interpret(sourceText, afforded)
  if (explicit.status === 'clarification_required') return { clarification: explicit.reason }
  // A player input carries no version of its own, so it takes the one the affordance it exercises
  // is offered at. Plain text is always speech; only commands select controlled operations.
  const offered = afforded.find(value => value.actionType === explicit.action.actionType)
  if (offered === undefined) return { clarification: 'action is not currently afforded' }
  const action = { ...explicit.action, actionVersion: offered.actionVersion, actorId: actor.characterId,
    actionId: deterministicId('action', { version: 'player-intent-action/v1', address: job.address, inputId: job.inputId, ordinal: 0 }) }
  const speech = action.parameters as WorldJsonObject
  const fragments = action.actionType === 'speak'
    ? [{ kind: 'narration' as const, text: speech.narration }, { kind: 'speech' as const, text: speech.text }]
      .filter((entry): entry is { kind: 'narration' | 'speech'; text: string } => typeof entry.text === 'string' && entry.text.length > 0)
    : [{ kind: 'action' as const, text: sourceText }]
  const source = fragments.map(entry => entry.text).join('\n')
  let offset = 0
  const sourceSpans = fragments.map(entry => {
    const span = { actionId: action.actionId, startUtf16: offset, endUtf16: offset + entry.text.length, text: entry.text, kind: entry.kind }
    offset = span.endUtf16 + 1
    return span
  })
  return { directSubmission: { version: 'player-submission/v2', sourceText: source, sourceTextHash: hashWorldJson('player-source-text/v1', source),
    actions: [action], sourceSpans, interpretationProfile: 'explicit-player-command/v1',
    interpretationReceiptHash: hashWorldJson('explicit-player-command/v1', { input: job.input, action }) } }
}
